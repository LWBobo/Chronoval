import type { H3Event } from 'h3'
import { eq, or, type SQL } from 'drizzle-orm'
import { requireVisiblePhoto } from './photo-access'
import { requireMusicAccess } from './music-access'
import { libraryMediaPath, mediaUrlPathMatches } from './media-reference'

async function requireMediaPhoto(event: H3Event, condition: SQL | undefined) {
  setHeader(event, 'Cache-Control', 'private, no-store')
  setHeader(event, 'Vary', 'Cookie')
  if (!condition) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const row = useDB()
    .select({ id: tables.photos.id })
    .from(tables.photos)
    .where(condition)
    .get()

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  return await requireVisiblePhoto(event, row.id, { allowAdminDeleted: true })
}

export async function requireStorageMediaAccess(
  event: H3Event,
  relativePath: string,
) {
  const pathname = `/storage/${relativePath}`
  try {
    return await requireMediaPhoto(
      event,
      or(
        eq(tables.photos.storageKey, relativePath),
        eq(tables.photos.thumbnailKey, relativePath),
        eq(tables.photos.livePhotoVideoKey, relativePath),
        mediaUrlPathMatches(tables.photos.originalUrl, pathname),
        mediaUrlPathMatches(tables.photos.thumbnailUrl, pathname),
        mediaUrlPathMatches(tables.photos.livePhotoVideoUrl, pathname),
      ),
    )
  } catch (error: any) {
    if (error?.statusCode !== 404) throw error
  }

  const music = useDB()
    .select({ id: tables.music.id })
    .from(tables.music)
    .where(mediaUrlPathMatches(tables.music.coverUrl, pathname))
    .get()
  if (music) return await requireMusicAccess(event, music.id)

  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
}

export async function requireLibraryMediaAccess(
  event: H3Event,
  mountName: string,
  relativePath: string,
) {
  const pathname = libraryMediaPath(mountName, relativePath)
  return await requireMediaPhoto(
    event,
    or(
      mediaUrlPathMatches(tables.photos.originalUrl, pathname),
      mediaUrlPathMatches(tables.photos.thumbnailUrl, pathname),
      mediaUrlPathMatches(tables.photos.livePhotoVideoUrl, pathname),
    ),
  )
}

export async function requireStorageKeyAccess(event: H3Event, key: string) {
  return await requireMediaPhoto(
    event,
    or(
      eq(tables.photos.storageKey, key),
      eq(tables.photos.thumbnailKey, key),
      eq(tables.photos.livePhotoVideoKey, key),
    ),
  )
}

export async function requireMediaReferenceAccess(
  event: H3Event,
  reference: string,
) {
  return await requireMediaPhoto(
    event,
    or(
      eq(tables.photos.originalUrl, reference),
      eq(tables.photos.thumbnailUrl, reference),
      eq(tables.photos.livePhotoVideoUrl, reference),
    ),
  )
}
