import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sendStream } from 'h3'
import { getLibraryMounts } from '~~/server/services/scan-library/manager'

/** 播放嵌在扫描库原图末尾的动态照片短视频，不另存一份文件。 */
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

  const start = Number(key.slice('embedded:'.length))
  const mount = getLibraryMounts().find(
    (item) => item.name === photo.libraryMount,
  )
  if (!mount || !Number.isFinite(start) || start <= 0) {
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
  if (start >= stat.size) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Motion video not found',
    })
  }

  setHeader(event, 'Content-Type', 'video/mp4')
  setHeader(event, 'Content-Length', String(stat.size - start))
  setHeader(event, 'Cache-Control', 'private, no-cache')
  return sendStream(event, createReadStream(abs, { start }))
})
