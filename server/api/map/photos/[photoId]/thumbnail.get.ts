import { photoAssetSql } from '../../../../utils/photo-media'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { and, eq, isNull, notInArray, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import sharp from 'sharp'
import { getStorageManager } from '~~/server/plugins/3.storage'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'
import { viewerFromActor } from '~~/server/services/ml/person.service'
import { loadPhotoImageBuffer } from '~~/server/services/ml/photo-image'
import { homepageGalleryVisibilitySql } from '~~/server/utils/gallery-visibility'

const CACHE_DIR = path.join(process.cwd(), 'data', 'map-thumbnail-cache', 'v1')
const ALLOWED_SIZES = new Set([64, 96, 128, 256])
const inflight = new Map<string, Promise<Buffer>>()

function requestedSize(event: H3Event): number {
  const raw = Number(getQuery(event).size ?? 96)
  return ALLOWED_SIZES.has(raw) ? raw : 96
}

async function loadSourceBuffer(photo: {
  id: string
  thumbnailKey: string | null
}): Promise<Buffer | null> {
  const loaded = await loadPhotoImageBuffer(photo.id)
  return loaded?.buffer ?? null
}

async function createCachedThumbnail(
  cacheFile: string,
  photo: { id: string; thumbnailKey: string | null },
  size: number,
): Promise<Buffer> {
  try {
    return await fs.readFile(cacheFile)
  } catch {
    // Cache miss.
  }

  const existing = inflight.get(cacheFile)
  if (existing) return existing

  const pending = (async () => {
    const source = await loadSourceBuffer(photo)
    if (!source) {
      throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
    }

    const output = await sharp(source, { animated: false, failOn: 'none' })
      .rotate()
      .resize(size, size, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: true,
      })
      .webp({ quality: size <= 128 ? 58 : 64, effort: 4 })
      .toBuffer()

    await fs.mkdir(CACHE_DIR, { recursive: true })
    const temporary = `${cacheFile}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, output)
    await fs.rename(temporary, cacheFile).catch(async () => {
      await fs.rm(temporary, { force: true })
    })
    return output
  })().finally(() => inflight.delete(cacheFile))

  inflight.set(cacheFile, pending)
  return pending
}

export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing photo id' })
  }

  const actor = await getActor(event)
  const where = [
    eq(tables.photos.id, photoId),
    isNull(tables.photos.deletedAt),
    homepageGalleryVisibilitySql(
      Boolean(actor.user),
      viewerFromActor(actor),
      actor.user?.id ?? null,
    ),
  ]

  const hiddenScanMounts = getGalleryHiddenScanMountSet()
  if (hiddenScanMounts.size > 0) {
    where.push(
      or(
        isNull(tables.photos.libraryMount),
        notInArray(tables.photos.libraryMount, [...hiddenScanMounts]),
      )!,
    )
  }

  const photo = useDB()
    .select({
      id: tables.photos.id,
      thumbnailKey: photoAssetSql('thumbnail'),
      thumbnailUrl: photoAssetSql('thumbnail'),
      lastModified: tables.photos.lastModified,
    })
    .from(tables.photos)
    .where(and(...where))
    .get()

  if (!photo || (!photo.thumbnailKey && !photo.thumbnailUrl)) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const size = requestedSize(event)
  const version = createHash('sha1')
    .update(
      `${photo.id}:${photo.thumbnailKey || photo.thumbnailUrl || ''}:${photo.lastModified || ''}:${size}`,
    )
    .digest('hex')
  const cacheFile = path.join(CACHE_DIR, `${version}.webp`)
  const etag = `"map-thumb-${version}"`

  setHeader(event, 'Content-Type', 'image/webp')
  setHeader(event, 'Cache-Control', 'private, no-store')
  setHeader(event, 'ETag', etag)
  setHeader(event, 'Vary', 'Cookie')
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return null
  }

  const output = await createCachedThumbnail(cacheFile, photo, size)
  setHeader(event, 'Content-Length', output.length)
  return output
})
