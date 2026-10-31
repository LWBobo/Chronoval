import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sendStream } from 'h3'
import { getLibraryMounts } from '~~/server/services/scan-library/manager'

/**
 * 解析 Range：支持 bytes=START-END / bytes=START- / bytes=-SUFFIX。
 * 返回相对「虚拟 mp4」的闭区间；非法则返回 null。
 */
const parseByteRange = (
  rangeHeader: string,
  total: number,
): { start: number; end: number } | null => {
  const matches = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!matches || total <= 0) return null

  const startTok = matches[1] ?? ''
  const endTok = matches[2] ?? ''

  // suffix：bytes=-N → 最后 N 字节
  if (!startTok && endTok) {
    const suffix = Number.parseInt(endTok, 10)
    if (Number.isNaN(suffix) || suffix <= 0) return null
    const start = Math.max(0, total - suffix)
    return { start, end: total - 1 }
  }

  const start = startTok ? Number.parseInt(startTok, 10) : 0
  const end = endTok ? Number.parseInt(endTok, 10) : total - 1

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    start >= total
  ) {
    return null
  }

  return { start, end: Math.min(end, total - 1) }
}

/**
 * 播放嵌在扫描库原图末尾的动态照片短视频，不另存一份文件。
 * 对外表现为独立 mp4 资源；Range 偏移相对该虚拟文件，再映射回原图内偏移。
 */
export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Photo ID is required',
    })
  }

  const { photo } = await requireVisiblePhoto(event, photoId)

  const key = photo?.livePhotoVideoKey || ''
  if (
    !photo?.isLivePhoto ||
    photo.deletedAt ||
    !key.startsWith('embedded:') ||
    photo.source !== 'library' ||
    !photo.libraryMount ||
    !photo.libraryPath
  ) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Motion video not found',
    })
  }

  const embeddedStart = Number(key.slice('embedded:'.length))
  const mount = getLibraryMounts().find(
    (item) => item.name === photo.libraryMount,
  )
  if (!mount || !Number.isFinite(embeddedStart) || embeddedStart <= 0) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Motion video not found',
    })
  }

  const root = path.resolve(mount.root)
  const abs = path.resolve(root, photo.libraryPath)
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Motion video not found',
    })
  }

  const stat = await fs.stat(abs)
  if (embeddedStart >= stat.size) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Motion video not found',
    })
  }

  // 虚拟 mp4 长度 = 原图尾部嵌入段
  const total = stat.size - embeddedStart

  setHeader(event, 'Content-Type', 'video/mp4')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Cache-Control', 'private, no-cache')
  setHeader(event, 'Vary', 'Cookie')
  // 避免 Nginx / OpenResty 把整段视频缓冲完才吐给浏览器
  setHeader(event, 'X-Accel-Buffering', 'no')

  // HEAD：只回元数据，方便播放器探测长度
  if (event.method === 'HEAD') {
    setHeader(event, 'Content-Length', String(total))
    return null
  }

  const range = getHeader(event, 'range')
  if (range) {
    const parsed = parseByteRange(range, total)
    if (!parsed) {
      setResponseStatus(event, 416)
      setHeader(event, 'Content-Range', `bytes */${total}`)
      return null
    }

    const { start, end } = parsed
    const fileStart = embeddedStart + start
    const fileEnd = embeddedStart + end

    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${total}`)
    setHeader(event, 'Content-Length', String(end - start + 1))
    return sendStream(event, createReadStream(abs, { start: fileStart, end: fileEnd }))
  }

  setHeader(event, 'Content-Length', String(total))
  return sendStream(event, createReadStream(abs, { start: embeddedStart }))
})
