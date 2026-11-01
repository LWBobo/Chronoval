import { and, eq, inArray } from 'drizzle-orm'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { H3Event } from 'h3'
import { tables, useDB } from '../../utils/db'
import { requireVisiblePhoto } from '../../utils/photo-access'
import { FixedStore } from './store'
import { resolveInsideRoot } from '../../utils/safe-path'

export async function serveRegisteredAsset(event: H3Event, id: string) {
  const file = useDB().select().from(tables.photoFiles).where(and(eq(tables.photoFiles.id, id), eq(tables.photoFiles.state, 'ready'))).get()
  if (!file) throw createError({ statusCode: 404, message: 'File not found' })
  const { photo, context } = await requireVisiblePhoto(event, file.photoId, { allowAdminDeleted: true, allowOwnerDeleted: true })
  const privileged = context.actor.isAdmin || context.actor.user?.id === photo.ownerId
  if (photo.stripLocation && !privileged && (file.role === 'original' || file.role === 'live_video')) throw createError({ statusCode: 404, message: 'File not found' })
  setHeader(event, 'Cache-Control', 'private, no-store')
  setHeader(event, 'Vary', 'Cookie')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  let target = file
  let base = 0
  let size = file.byteSize
  if (file.locatorType === 'embedded') {
    const parent = useDB().select().from(tables.photoFiles).where(eq(tables.photoFiles.id, file.parentFileId!)).get()
    if (!parent || parent.photoId !== file.photoId || parent.role !== 'original' || parent.locatorType === 'embedded' || parent.state !== 'ready' || file.byteOffset === null || file.byteLength === null || file.byteOffset + file.byteLength > parent.byteSize) throw createError({ statusCode: 404, message: 'File not found' })
    target = parent; base = file.byteOffset; size = file.byteLength
  }
  let absolute: string | null = null
  if (target.locatorType === 'provider') {
    const metadata = await new FixedStore(target.storageProviderId!).meta(target.storageKey!)
    if (!metadata || metadata.size !== target.byteSize) throw createError({ statusCode: 404, message: 'File not found' })
  } else {
    const lib = useDB().select().from(tables.libraries).where(eq(tables.libraries.id, target.libraryId!)).get()
    if (!lib || !lib.enabled) throw createError({ statusCode: 404, message: 'File not found' })
    const root = await realpath(lib.rootPath)
    absolute = await realpath(resolveInsideRoot(root, target.libraryPath!))
    const relative = path.relative(root, absolute)
    const metadata = await stat(absolute)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !metadata.isFile() || metadata.size !== target.byteSize) throw createError({ statusCode: 404, message: 'File not found' })
  }
  let start = 0, end = size - 1
  const etag = `"${file.id}-${file.contentVersion}-${file.byteSize}"`
  const range = getHeader(event, 'range')
  const ifRange = getHeader(event, 'if-range')
  if (range && (!ifRange || ifRange === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) throw createError({ statusCode: 416, message: 'Invalid range' })
    if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); if (suffix <= 0) start = size }
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])) }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { setHeader(event, 'Content-Range', `bytes */${size}`); throw createError({ statusCode: 416, message: 'Invalid range' }) }
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${size}`)
  }
  setHeader(event, 'ETag', etag)
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Content-Type', file.mimeType)
  setHeader(event, 'Content-Length', Math.max(0, end - start + 1))
  if (getQuery(event).download === '1') setHeader(event, 'Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.originalFilename || 'download')}`)
  if (event.method === 'HEAD' || size === 0) { event.node.res.end(); return }
  if (target.locatorType === 'provider') return sendStream(event, await new FixedStore(target.storageProviderId!).read(target.storageKey!, base + start, base + end))
  return sendStream(event, (await open(absolute!, constants.O_RDONLY | constants.O_NOFOLLOW)).createReadStream({ start: base + start, end: base + end }))
}

export function withAssetUrls<T extends { id: string; stripLocation?: boolean; type?: string }>(row: T, privileged = false, registry?: Array<typeof tables.photoFiles.$inferSelect>) {
  const files = registry ?? useDB().select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, row.id), eq(tables.photoFiles.state, 'ready'))).all()
  const url = (role: string) => { const file = files.find((f) => f.role === role); return file ? `/api/assets/${file.id}` : null }
  const original = row.stripLocation && !privileged ? url('sanitized_download') ?? (row.type === 'video' ? null : url('preview')) : row.type === 'video' ? url('original') : url('preview') ?? url('original')
  return { ...row, originalUrl: original, downloadUrl: row.stripLocation && !privileged ? url('sanitized_download') : url('original'), thumbnailUrl: url('thumbnail') ?? url('poster') ?? original, livePhotoVideoUrl: row.stripLocation && !privileged ? null : url('live_video') }
}

export function withAssetUrlsBatch<T extends { id: string; stripLocation?: boolean; type?: string }>(rows: T[], privileged: boolean | ((row: T) => boolean) = false) {
  const files = new Map<string, Array<typeof tables.photoFiles.$inferSelect>>()
  for (let offset = 0; offset < rows.length; offset += 400) {
    const batch = rows.slice(offset, offset + 400)
    for (const file of useDB().select().from(tables.photoFiles).where(and(inArray(tables.photoFiles.photoId, batch.map(row => row.id)), eq(tables.photoFiles.state, 'ready'))).all()) {
      const group = files.get(file.photoId) ?? []
      group.push(file); files.set(file.photoId, group)
    }
  }
  return rows.map(row => withAssetUrls(row, typeof privileged === 'function' ? privileged(row) : privileged, files.get(row.id) ?? []))
}
