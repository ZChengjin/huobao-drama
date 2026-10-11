/**
 * 视频生成自动队列 — 进程内常驻定时器，按镜头顺序逐个执行未完成的视频任务
 * - 每 5 分钟检查一次：只要「视频任务列表」存在未完成（待生成 / processing / failed）任务就继续
 * - 一次只触发一个视频任务，避免 Agnes 等厂商限流（video_queue_full）
 * - 成功或失败后都等 5 分钟再执行下一个镜头
 * - 参数口径对齐 POST /tasks 视频分支：风格注入、@名字→@图片N 映射、绑定素材参考图、集锁定配置
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { generateVideo } from './generation.js'
import { getDramaStylePrompt } from './style-preset.js'
import {
  logTaskError,
  logTaskProgress,
  logTaskStart,
  logTaskSuccess,
} from '../utils/task-logger.js'

const RETRY_INTERVAL_MS = 5 * 60 * 1000

type QueueState = 'idle' | 'scanning' | 'executing' | 'waiting'

interface VideoQueueStatus {
  state: QueueState
  enabled: boolean
  current_storyboard_id?: number
  current_shot_number?: number
  current_episode_id?: number
  last_run_at?: string
  last_error?: string
  interval_sec: number
}

let status: VideoQueueStatus = {
  state: 'idle',
  enabled: false,
  interval_sec: RETRY_INTERVAL_MS / 1000,
}
let timer: ReturnType<typeof setInterval> | null = null
let running = false

function markState(state: QueueState) {
  status = { ...status, state }
}

/** 分镜绑定的素材图片，按「场景→角色→道具」顺序收集（上限 9 张），并返回名字→参考图序号映射 */
async function getStoryboardRefs(storyboardId: number): Promise<{ refs: string[]; nameToIndex: Record<string, number> }> {
  const [sb] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))

  // 场景（当前分镜绑定的 scene_id）
  let sceneImageUrl: string | null = null
  let sceneLocation = ''
  if (sb?.sceneId) {
    const [sceneRow] = await db.select({
      imageUrl: schema.scenes.imageUrl,
      location: schema.scenes.location,
    }).from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId))
    sceneImageUrl = sceneRow?.imageUrl ?? null
    sceneLocation = sceneRow?.location ?? ''
  }

  // 角色
  const charLinks = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  const charIds = charLinks.map(link => link.characterId)
  const characters = charIds.length
    ? (await db.select().from(schema.characters).where(inArray(schema.characters.id, charIds)))
      .filter(c => charIds.includes(c.id) && !c.deletedAt)
    : []

  // 道具
  const propLinks = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  const propIds = propLinks.map(link => link.propId)
  const props = propIds.length
    ? (await db.select().from(schema.props).where(inArray(schema.props.id, propIds)))
      .filter(p => propIds.includes(p.id) && !p.deletedAt)
    : []

  const refs: string[] = []
  const nameToIndex: Record<string, number> = {}
  const push = (name: string, url?: string | null) => {
    const v = String(url || '').trim()
    if (!v || refs.includes(v) || refs.length >= 9) return
    refs.push(v)
    if (name && !(name in nameToIndex)) nameToIndex[name] = refs.length
  }

  // 场景：按地点名引用（与前端 getShotReferenceIndexMap 口径一致）
  if (sceneImageUrl && sceneLocation) push(sceneLocation, sceneImageUrl)
  // 角色
  for (const c of characters) push(c.name, c.imageUrl)
  // 道具
  for (const p of props) push(p.name, p.imageUrl)

  return { refs, nameToIndex }
}

/** 将视频提示词里的 @名字 替换为 @图片N名字（N 为参考图序号，1 起），与前端 resolveVideoPromptRefs 一致 */
async function resolveStoryboardVideoPrompt(
  storyboardId: number,
): Promise<{ prompt: string; refs: string[] }> {
  const [sb] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  const { refs, nameToIndex } = await getStoryboardRefs(storyboardId)
  const prompt = (sb?.videoPrompt || '').trim()
  if (!refs.length || !prompt) return { prompt, refs }

  const names = Object.keys(nameToIndex).sort((a, b) => b.length - a.length)
  const resolved = prompt.replace(/@([^\s@]+)/g, (match, raw) => {
    for (const name of names) {
      if (raw.startsWith(name)) return `@图片${nameToIndex[name]}${raw.slice(name.length)}`
    }
    return match
  })
  return { prompt: resolved, refs }
}

/**
 * 按镜头顺序取下一个待处理分镜：
 * 1. 已有处理中（processing）视频任务且尚无视频 → 等待该任务完成（5 分钟后再看）
 * 2. 有 failed 记录且尚无视频 → 重新触发该镜头
 * 3. 尚无视频、无任务记录的分镜 → 按「集 + 镜头序号」顺序取第一个
 */
async function findNextPendingStoryboard(): Promise<number | null> {
  // 1. 有 processing 任务且尚无视频：等待其完成
  const processing = (await db.select({ storyboardId: schema.sysTask.storyboardId })
    .from(schema.sysTask)
    .where(and(
      eq(schema.sysTask.type, 'video'),
      eq(schema.sysTask.status, 'processing'),
    )))
      .filter(t => t.storyboardId != null)
  if (processing.length) {
    const sbs = await db.select().from(schema.storyboards)
      .where(inArray(schema.storyboards.id, processing.map(t => t.storyboardId!)))
    const active = sbs
      .filter(sb => !sb.videoUrl)
      .sort((a, b) => a.episodeId - b.episodeId || a.storyboardNumber - b.storyboardNumber)
    if (active.length) return active[0].id
  }

  // 2. 有 failed 记录且尚无视频：重试该镜头
  const failed = (await db.select({ storyboardId: schema.sysTask.storyboardId })
    .from(schema.sysTask)
    .where(and(
      eq(schema.sysTask.type, 'video'),
      eq(schema.sysTask.status, 'failed'),
    )))
      .filter(t => t.storyboardId != null)
  if (failed.length) {
    const sbs = await db.select().from(schema.storyboards)
      .where(inArray(schema.storyboards.id, failed.map(t => t.storyboardId!)))
    const retryable = sbs
      .filter(sb => !sb.videoUrl)
      .sort((a, b) => a.episodeId - b.episodeId || a.storyboardNumber - b.storyboardNumber)
    if (retryable.length) return retryable[0].id
  }

  // 3. 尚无视频、无任务记录的分镜，按「集 + 镜头序号」顺序
  const sbs = await db.select().from(schema.storyboards)
  const pending = sbs
    .filter(sb => !sb.videoUrl)
    .sort((a, b) => a.episodeId - b.episodeId || a.storyboardNumber - b.storyboardNumber)
  return pending.length ? pending[0].id : null
}

// 分镜在视频任务列表中已有 processing/failed 记录时，优先重试该镜头而不是跳到下一个镜头

/** 为指定分镜触发一次视频生成（口径对齐 POST /tasks 视频分支） */
async function triggerStoryboardVideo(storyboardId: number): Promise<void> {
  const [sb] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)

  // 已有处理中（processing）任务时分镜会等待该任务完成；
  // 若只剩 failed 记录（无 processing），则重新触发一次生成
  const active = await db.select().from(schema.sysTask)
    .where(and(
      eq(schema.sysTask.type, 'video'),
      eq(schema.sysTask.storyboardId, storyboardId),
      eq(schema.sysTask.status, 'processing'),
    ))
  if (active.length) {
    logTaskProgress('VideoQueue', 'skip-active', { storyboardId })
    return
  }

  const [ep] = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error(`Episode ${sb.episodeId} not found`)

  const [drama] = await db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, ep.dramaId))

  const { prompt: videoPrompt, refs } = await resolveStoryboardVideoPrompt(storyboardId)
  if (!videoPrompt.trim() && !refs.length) {
    throw new Error(`Storyboard ${storyboardId} 缺少视频提示词或参考素材，无法生成`)
  }

  // 风格词注入（与 /tasks 一致）
  let finalPrompt = videoPrompt
  const stylePrompt = await getDramaStylePrompt(ep.dramaId)
  if (finalPrompt.trim() && stylePrompt) finalPrompt = `${stylePrompt}，\n${finalPrompt}`

  const duration = sb.duration && sb.duration > 0 ? sb.duration : 10

  logTaskStart('VideoQueue', 'trigger', {
    storyboardId,
    shotNumber: sb.storyboardNumber,
    episodeId: ep.id,
    duration,
    resolution: ep.resolution,
    refCount: refs.length,
    configId: ep.videoConfigId ?? undefined,
  })

  await generateVideo({
    storyboardId,
    dramaId: ep.dramaId,
    prompt: finalPrompt,
    duration,
    aspectRatio: drama?.aspectRatio || '16:9',
    resolution: ep.resolution,
    generateAudio: true,
    referenceImageUrls: refs,
    configId: ep.videoConfigId ?? undefined,
  })

  logTaskSuccess('VideoQueue', 'triggered', { storyboardId, shotNumber: sb.storyboardNumber })
}

/** 单次扫描：无任务则 idle；有任务则按镜头顺序触发一个，之后 5 分钟再扫 */
async function scanOnce() {
  if (running || !status.enabled) return
  running = true
  markState('scanning')
  try {
    const next = await findNextPendingStoryboard()
    if (!next) {
      markState('idle')
      logTaskProgress('VideoQueue', 'no-pending', {})
      return
    }

    status = { ...status, current_storyboard_id: next }
    markState('executing')
    await triggerStoryboardVideo(next)

    markState('waiting')
    status.last_run_at = new Date().toISOString()
    logTaskProgress('VideoQueue', 'scheduled-next', {
      storyboardId: next,
      nextCheckInSec: RETRY_INTERVAL_MS / 1000,
    })
  } catch (err: any) {
    status = { ...status, last_error: err.message }
    markState('waiting')
    logTaskError('VideoQueue', 'scan-error', { error: err.message })
  } finally {
    running = false
  }
}

export function startVideoQueueLoop(): void {
  if (timer) return
  status.enabled = true
  logTaskStart('VideoQueue', 'loop-start', { intervalSec: RETRY_INTERVAL_MS / 1000 })
  timer = setInterval(() => { void scanOnce() }, RETRY_INTERVAL_MS)
  void scanOnce()
}

export function stopVideoQueueLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  status.enabled = false
  logTaskProgress('VideoQueue', 'loop-stopped', {})
}

export function getVideoQueueStatus(): VideoQueueStatus {
  return { ...status }
}

/** 启动/停止自动队列；enabled 时立即扫描一次，之后每 5 分钟扫描 */
export function setVideoQueueEnabled(enabled: boolean): void {
  status.enabled = enabled
  if (enabled) startVideoQueueLoop()
  else stopVideoQueueLoop()
}
