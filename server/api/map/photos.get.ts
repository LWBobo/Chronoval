import { photoAssetSql } from '../../utils/photo-media'
import { createHash } from 'node:crypto'
import { and, eq, asc, isNotNull, isNull, notInArray, or } from 'drizzle-orm'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'
import { viewerFromActor } from '~~/server/services/ml/person.service'
import { homepageGalleryVisibilitySql } from '~~/server/utils/gallery-visibility'
import type { GlobeMapPayload } from '~~/shared/types/map'

function exifNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const fraction = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/)
  if (fraction) {
    const denominator = Number(fraction[2])
    const numerator = Number(fraction[1])
    return denominator && Number.isFinite(numerator)
      ? numerator / denominator
      : null
  }
  const match = trimmed.match(/-?\d+(?:\.\d+)?/)
  const parsed = match ? Number(match[0]) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

export default eventHandler(async (event): Promise<GlobeMapPayload> => {
  const actor = await getActor(event)
  const where = [
    isNull(tables.photos.deletedAt),
    actor.isAdmin ? undefined : eq(tables.photos.stripLocation,false),
    isNotNull(tables.photos.latitude),
    isNotNull(tables.photos.longitude),
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

  const rows = useDB()
    .select({
      id: tables.photos.id,
      latitude: tables.photos.latitude,
      longitude: tables.photos.longitude,
      dateTaken: tables.photos.dateTaken,
      title: tables.photos.title,
      city: tables.photos.city,
      locationName: tables.photos.locationName,
      thumbnailUrl: photoAssetSql('thumbnail'),
      thumbnailHash: tables.photos.thumbnailHash,
      lastModified: tables.photos.lastModified,
      exif: tables.photos.exif,
    })
    .from(tables.photos)
    .where(and(...where))
    .orderBy(asc(tables.photos.dateTaken), asc(tables.photos.id))
    .all()

  return {
    photos: rows.map((row) => {
      const exif = (row.exif ?? {}) as Record<string, unknown>
      const altitude = exifNumber(exif.GPSAltitude)
      const belowSeaLevel = exif.GPSAltitudeRef === 'Below Sea Level'
      const thumbnailVersion = createHash('sha1')
        .update(
          `${row.thumbnailUrl || ''}:${row.lastModified || ''}`,
        )
        .digest('hex')
        .slice(0, 12)
      return {
        id: row.id,
        latitude: row.latitude!,
        longitude: row.longitude!,
        dateTaken: row.dateTaken,
        title: row.title,
        city: row.city,
        locationName: row.locationName,
        thumbnailUrl: row.thumbnailUrl,
        mapThumbnailUrl:
          row.thumbnailUrl
            ? `/api/map/photos/${encodeURIComponent(row.id)}/thumbnail?v=${thumbnailVersion}`
            : null,
        thumbnailHash: row.thumbnailHash,
        focalLength: exifNumber(
          exif.FocalLengthIn35mmFormat ?? exif.FocalLength,
        ),
        shutterSeconds: exifNumber(exif.ExposureTime),
        altitude:
          altitude == null
            ? null
            : belowSeaLevel
              ? -Math.abs(altitude)
              : altitude,
        cameraModel:
          typeof exif.Model === 'string' && exif.Model.trim()
            ? exif.Model.trim()
            : null,
      }
    }),
  }
})
