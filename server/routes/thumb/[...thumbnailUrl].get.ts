import {
  decodeMediaPath,
  respondWithPrivateMedia,
} from '../../utils/media-http'
import { resolveInsideRoot } from '../../utils/safe-path'
import { promises as fs } from 'node:fs'
import sharp from 'sharp'

const MAX_REMOTE_THUMBNAIL_BYTES = 20 * 1024 * 1024

async function fetchRemoteThumbnail(url: string): Promise<Buffer> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const response = await fetch(parsed, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!response?.ok || !response.body) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > MAX_REMOTE_THUMBNAIL_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Thumbnail too large' })
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_REMOTE_THUMBNAIL_BYTES) {
      await reader.cancel()
      throw createError({
        statusCode: 413,
        statusMessage: 'Thumbnail too large',
      })
    }
    chunks.push(value)
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  )
}

export default eventHandler(async (event) => {
  const { storageProvider } = useStorageProvider(event)

  let url = getRouterParam(event, 'thumbnailUrl')

  if (!url) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid thumbnailUrl',
    })
  }

  try {
    url = decodeURIComponent(url)
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid media reference',
    })
  }

  await requireMediaReferenceAccess(event, url)

  // 缩略图内容由路径唯一决定、可随时重算，浏览器可安全长期缓存（大幅减少重复回源码）
  setHeader(event, 'Cache-Control', 'private, no-cache')
  setHeader(event, 'Vary', 'Cookie')

  // 扫描库缩略图（兼容旧版就地在挂载目录 thumbnails/ 生成的路径；新版本已统一写入
  // 内部存储 thumbnails/<mount>/…，走下方 /storage/ 分支）：此分支直接读磁盘返回。
  // 若为不再被引用的旧路径文件缺失，回落到 404，不影响新存储的缩略图渲染。
  // 避免走下方的 `fetch(url)`——相对 URL 在服务端 fetch 会抛错导致 OG 生成黑屏。
  if (url.startsWith('/library/')) {
    const { getLibraryMounts } =
      await import('~~/server/services/scan-library/manager')
    const rest = url.replace(/^\/library\//, '')
    const slash = rest.indexOf('/')
    const mountName = slash === -1 ? rest : rest.slice(0, slash)
    const relRaw = slash === -1 ? '' : rest.slice(slash + 1)

    const mount = getLibraryMounts().find((m) => m.name === mountName)
    if (!mount) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }

    const decodedRel = decodeMediaPath(relRaw)

    const absolute = resolveInsideRoot(mount.root, decodedRel)

    let thumb: Buffer
    try {
      thumb = await fs.readFile(absolute)
    } catch {
      throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
    }
    return respondWithPrivateMedia(
      event,
      await sharp(thumb).rotate().jpeg({ quality: 85 }).toBuffer(),
      'image/jpeg',
    )
  }

  // 本地存储：直接从磁盘读取缩略图文件，避免服务器回连自身公网域名
  // （此前用 `fetch(\`${host}${url}\`)` 在沙箱内无法访问 dev.1xc.top 这类
  //   公网域名，导致 OG 生成黑屏 / 缩略图 500）
  if (
    storageProvider.config?.provider === 'local' &&
    url.startsWith('/storage/')
  ) {
    const basePath = (storageProvider.config as any).basePath as string
    const relRaw = url.replace(/^\/storage\//, '')
    const relPath = decodeMediaPath(relRaw)

    const absolute = resolveInsideRoot(basePath, relPath)

    let photo: Buffer
    try {
      photo = await fs.readFile(absolute)
    } catch {
      throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
    }

    return respondWithPrivateMedia(
      event,
      await sharp(photo).rotate().jpeg({ quality: 85 }).toBuffer(),
      'image/jpeg',
    )
  }

  const photo = await fetchRemoteThumbnail(url)

  const sharpInst = sharp(photo).rotate()
  return respondWithPrivateMedia(
    event,
    await sharpInst.jpeg({ quality: 85 }).toBuffer(),
    'image/jpeg',
  )
})
