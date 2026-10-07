import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('video queue service runs a 5-minute single-task loop', () => {
  const svc = read('src/services/video-queue.ts')

  // 常驻定时器，间隔 5 分钟
  assert.match(svc, /RETRY_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/)
  assert.match(svc, /setInterval\(\(\)\s*=>\s*\{\s*void scanOnce\(\)\s*\},\s*RETRY_INTERVAL_MS\)/)

  // 一次只触发一个任务，按镜头顺序（集 + 镜头序号）
  assert.match(svc, /a\.episodeId\s*-\s*b\.episodeId\s*\|\|\s*a\.storyboardNumber\s*-\s*b\.storyboardNumber/)

  // 任务列表里有 processing/failed 记录的分镜优先处理；已有 processing 任务时跳过不重复触发
  assert.match(svc, /eq\(schema\.sysTask\.status,\s*'processing'\)/)
  assert.match(svc, /eq\(schema\.sysTask\.status,\s*'failed'\)/)
  assert.match(svc, /skip-active/)

  // 参数口径对齐 /tasks：风格注入、绑定素材参考图、@名字映射、集锁定配置
  assert.match(svc, /getDramaStylePrompt\(ep\.dramaId\)/)
  assert.match(svc, /generateVideo\(\{[\s\S]*referenceImageUrls:\s*refs/)
  assert.match(svc, /@图片\$\{nameToIndex\[name\]\}/)
  assert.match(svc, /configId:\s*ep\.videoConfigId/)

  // 开关与状态查询
  assert.match(svc, /export function getVideoQueueStatus\(\)/)
  assert.match(svc, /export function setVideoQueueEnabled\(/)
})

test('tasks route exposes video-queue control endpoints', () => {
  const route = read('src/routes/tasks.ts')
  assert.match(route, /app\.get\('\/video-queue\/status'/)
  assert.match(route, /app\.post\('\/video-queue\/start'/)
  assert.match(route, /app\.post\('\/video-queue\/stop'/)
  // 两段静态路径与 /tasks/:id 单段参数路由不冲突
  assert.match(route, /app\.get\('\/:id'/)
})

test('backend startup starts the video queue loop', () => {
  const index = read('src/index.ts')
  assert.match(index, /import \{ startVideoQueueLoop \} from '\.\/services\/video-queue\.js'/)
  assert.match(index, /startVideoQueueLoop\(\)/)
})
