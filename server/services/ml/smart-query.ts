import { eq, inArray, or } from 'drizzle-orm'
import type { NeededExif } from '~~/shared/types/photo'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'
import { searchOcr } from './ocr.service'
import { searchSmart, type SmartSearchHit } from './smart-search.service'

export interface SmartQueryFilters {
  dateFrom?: string
  dateTo?: string
  cameras?: string[]
  lenses?: string[]
  cities?: string[]
  tags?: string[]
  minRating?: number
  albumId?: number
}

export type SmartQueryMode = 'all' | 'clip' | 'ocr'

function dayOf(value: string | null | undefined) {
  if (!value) return ''
  return value.slice(0, 10)
}

function photoMatchesFilters(
  photo: {
    dateTaken: string | null
    city: string | null
    tags: string[] | null
    exif: NeededExif | null
  },
  filters: SmartQueryFilters,
) {
  if (filters.dateFrom || filters.dateTo) {
    const day = dayOf(photo.dateTaken)
    if (!day) return false
    if (filters.dateFrom && day < filters.dateFrom) return false
    if (filters.dateTo && day > filters.dateTo) return false
  }

  const exif = photo.exif || {}
  if (filters.cameras?.length) {
    const camera =
      exif.Make && exif.Model ? `${exif.Make} ${exif.Model}` : ''
    if (!filters.cameras.includes(camera)) return false
  }
  if (filters.lenses?.length) {
    const lens =
      exif.LensMake && exif.LensModel
        ? `${exif.LensMake} ${exif.LensModel}`
        : exif.LensModel || ''
    if (!filters.lenses.includes(lens)) return false
  }
  if (filters.cities?.length) {
    if (!photo.city || !filters.cities.includes(photo.city)) return false
  }
  if (filters.tags?.length) {
    const tags = photo.tags || []
    if (!filters.tags.some((tag) => tags.includes(tag))) return false
  }
  if (filters.minRating && filters.minRating > 0) {
    if ((exif.Rating || 0) < filters.minRating) return false
  }
  return true
}

function hasMetadataFilters(filters?: SmartQueryFilters) {
  if (!filters) return false
  return Boolean(
    filters.dateFrom ||
      filters.dateTo ||
      filters.cameras?.length ||
      filters.lenses?.length ||
      filters.cities?.length ||
      filters.tags?.length ||
      (filters.minRating && filters.minRating > 0) ||
      filters.albumId,
  )
}

/** Drop photos hidden from the public gallery (hidden albums / disabled scan mounts). */
export function filterVisibleHits(hits: SmartSearchHit[]): SmartSearchHit[] {
  if (!hits.length) return []

  const db = useDB()
  const hiddenAlbumPhotos = db
    .select({ photoId: tables.albumPhotos.photoId })
    .from(tables.albumPhotos)
    .innerJoin(tables.albums, eq(tables.albumPhotos.albumId, tables.albums.id))
    .where(
      or(
        eq(tables.albums.isHidden, true),
        eq(tables.albums.hideFromGallery, true),
      ),
    )
    .all()
  const hiddenIds = new Set(hiddenAlbumPhotos.map((r) => r.photoId))
  const hiddenScanMounts = getGalleryHiddenScanMountSet()
  const ids = hits.map((h) => h.photoId)

  const rows = db
    .select({
      id: tables.photos.id,
      deletedAt: tables.photos.deletedAt,
      libraryMount: tables.photos.libraryMount,
    })
    .from(tables.photos)
    .where(inArray(tables.photos.id, ids))
    .all()

  const visible = new Set(
    rows
      .filter((p) => {
        if (p.deletedAt) return false
        if (hiddenIds.has(p.id)) return false
        if (
          p.libraryMount &&
          hiddenScanMounts.size > 0 &&
          hiddenScanMounts.has(p.libraryMount)
        ) {
          return false
        }
        return true
      })
      .map((p) => p.id),
  )

  return hits.filter((h) => visible.has(h.photoId))
}

function applyMetadataFilters(
  hits: SmartSearchHit[],
  filters?: SmartQueryFilters,
): SmartSearchHit[] {
  if (!hits.length || !hasMetadataFilters(filters)) return hits
  const spec = filters!

  const db = useDB()
  let allowed: Set<string> | null = null
  if (spec.albumId) {
    allowed = new Set(
      db
        .select({ id: tables.albumPhotos.photoId })
        .from(tables.albumPhotos)
        .where(eq(tables.albumPhotos.albumId, spec.albumId))
        .all()
        .map((r) => r.id),
    )
    if (!allowed.size) return []
  }

  const ids = hits
    .map((h) => h.photoId)
    .filter((id) => !allowed || allowed.has(id))
  if (!ids.length) return []

  const rows = db
    .select({
      id: tables.photos.id,
      dateTaken: tables.photos.dateTaken,
      city: tables.photos.city,
      tags: tables.photos.tags,
      exif: tables.photos.exif,
    })
    .from(tables.photos)
    .where(inArray(tables.photos.id, ids))
    .all()

  const ok = new Set(
    rows.filter((row) => photoMatchesFilters(row, spec)).map((row) => row.id),
  )
  return hits.filter((h) => ok.has(h.photoId))
}

/** CLIP and/or OCR search, then gallery visibility and EXIF/date/album filters. */
export async function querySmart(options: {
  q: string
  limit?: number
  mode?: SmartQueryMode
  filters?: SmartQueryFilters
}): Promise<SmartSearchHit[]> {
  const q = options.q.trim()
  const limit = Math.min(200, Math.max(1, options.limit || 50))
  const mode = options.mode || 'all'
  if (!q) return []

  let results: SmartSearchHit[] = []

  if (mode === 'ocr') {
    const ids = await searchOcr(q, limit)
    results = ids.map((photoId) => ({
      photoId,
      distance: 0,
      score: 1,
      source: 'ocr' as const,
    }))
  } else if (mode === 'clip') {
    results = await searchSmart(q, { limit, includeOcr: false })
  } else {
    try {
      results = await searchSmart(q, { limit, includeOcr: true })
    } catch (err: any) {
      if (err?.statusCode === 503) {
        const ids = await searchOcr(q, limit)
        results = ids.map((photoId) => ({
          photoId,
          distance: 0.99,
          score: 0.01,
          source: 'ocr' as const,
        }))
      } else {
        throw err
      }
    }
  }

  results = filterVisibleHits(results)
  results = applyMetadataFilters(results, options.filters)
  return results.slice(0, limit)
}
