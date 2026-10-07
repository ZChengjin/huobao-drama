/**
 * OpenAI Videos 兼容视频生成 Adapter（Agnes 等）
 * 创建任务: POST {base}/v1/videos
 * 查询任务: GET  {base}/agnesapi?video_id=<VIDEO_ID>&model_name=<model>（仅 text 模式可省略 model_name）
 *
 * 生成模式：
 * - text      纯文本生成视频
 * - keyframe  首帧/尾帧控制（first_frame / last_frame，至少一个）
 * - reference 参考素材生成（images ≤5、audios ≤3，Flash 不支持参考视频）
 *
 * 限制（以 agnes.md 文档为准）：
 * - size 固定 "720P"，画幅通过 aspect_ratio 选择
 * - seconds 字符串 "4"–"12"，n 固定 1
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

/** 默认模型：Agnes Video 2.5 Flash */
const DEFAULT_MODEL = 'agnes-video-2.5-flash'
/** 参考素材上限：图片 5、音频 3（Flash） */
const REF_LIMITS = { images: 5, audios: 3 } as const
/** seconds 字符串取值范围 */
const SECONDS_MIN = 4
const SECONDS_MAX = 12

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

export class OpenAIVideoAdapter implements VideoProviderAdapter {
  provider = 'openai'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const prompt = (record.prompt || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    // OpenAI Videos 兼容接口（Agnes）不支持参考视频
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    if (refVideos.length) {
      throw new Error('该视频服务不支持参考视频，请移除参考视频后重试')
    }
    if (refImages.length > REF_LIMITS.images) {
      throw new Error(`参考图片超限：最多 ${REF_LIMITS.images} 张（当前 ${refImages.length}）`)
    }
    if (refAudios.length > REF_LIMITS.audios) {
      throw new Error(`参考音频超限：最多 ${REF_LIMITS.audios} 段（当前 ${refAudios.length}）`)
    }

    let mode: 'text' | 'keyframe' | 'reference' = 'text'
    const body: any = {
      model,
      prompt,
      seconds: this.normalizeSeconds(record.duration),
      size: '720P',
    }
    if (record.aspectRatio) body.aspect_ratio = record.aspectRatio

    const firstFrame = record.firstFrameUrl
    const lastFrame = record.lastFrameUrl
    if (firstFrame || lastFrame) {
      mode = 'keyframe'
      if (firstFrame) body.first_frame = firstFrame
      if (lastFrame) body.last_frame = lastFrame
    } else if (refImages.length || refAudios.length) {
      mode = 'reference'
      if (refImages.length) body.images = refImages
      if (refAudios.length) body.audios = refAudios
    }
    body.mode = mode

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result.video_id || result.task_id || result.id
    if (taskId) {
      return { isAsync: true, taskId: String(taskId) }
    }
    // 同步返回
    const videoUrl = result.url || result.video_url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No video_id or video URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    // 推荐轮询：video_id + model_name（text/keyframe/reference 全部模式均适用）
    // model_name 取配置中的模型（与创建任务时一致），缺省回退 Flash 默认模型
    const modelName = config.model || DEFAULT_MODEL
    const url = new URL(joinProviderUrl(config.baseUrl, '', '/agnesapi'))
    url.searchParams.set('video_id', taskId)
    url.searchParams.set('model_name', modelName)
    return {
      url: url.toString(),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status
    if (status === 'completed') {
      // 顶层 url 字段为视频地址；以 status/progress 为准，忽略 internal_* 字段
      return { status: 'completed', videoUrl: result.url }
    }
    if (status === 'failed') {
      const err = result.error
      const msg = typeof err === 'string' ? err : (err || 'Video generation failed')
      return { status: 'failed', error: msg }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.url || result.video_url || null
  }

  private normalizeSeconds(duration?: number | null): string {
    const parsed = Math.round(Number(duration || DEFAULT_SECONDS))
    if (!Number.isFinite(parsed)) return String(DEFAULT_SECONDS)
    return String(Math.min(SECONDS_MAX, Math.max(SECONDS_MIN, parsed)))
  }
}

const DEFAULT_SECONDS = 5
