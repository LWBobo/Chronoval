import { createHash } from 'node:crypto'
import {
  createError,
  getHeader,
  setHeader,
  setResponseStatus,
  type H3Event,
} from 'h3'

/** 仅在 HTTP 路径边界解码一次；字面量百分号应由客户端编码成 %25。 */
export function decodeMediaPath(value: string): string {
  try {
    return decodeURIComponent(value)
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '')
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid media path' })
  }
}

/** 权限检查必须先执行；缓存的字节可复用，但每次使用都需向服务端重新验证。 */
export function respondWithPrivateMedia(
  event: H3Event,
  buffer: Buffer,
  contentType?: string,
) {
  const etag = `"${createHash('sha256').update(buffer).digest('base64url')}"`
  setHeader(event, 'Cache-Control', 'private, no-cache')
  setHeader(event, 'Vary', 'Cookie')
  setHeader(event, 'ETag', etag)
  if (contentType) setHeader(event, 'Content-Type', contentType)
  if (getHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return null
  }
  return buffer
}
