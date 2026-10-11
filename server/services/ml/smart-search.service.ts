import { eq } from 'drizzle-orm'
import { encodeImage, encodeText, MlUnavailableError } from './client'
import { clipMinScore, clipModel, clipTopK, isClipEnabled } from './config'
import { withClipLimit } from './limit'
import { loadPhotoImageBuffer } from './photo-image'
import {
  bufferToFloat32,
  cosineDistance,
  float32ToBuffer,
} from './vector'
import { searchOcr } from './ocr.service'

const log = () => logger.dynamic('ml-smart-search')

export async function processSmartSearch(photoId: string) {
  return withClipLimit(() => processSmartSearchUnlocked(photoId))
}

async function processSmartSearchUnlocked(photoId: string) {
  if (!(await isClipEnabled())) {
    log().info(`CLIP disabled; skip ${photoId}`)
    return
  }

  const loaded = await loadPhotoImageBuffer(photoId)
  if (!loaded) throw new Error(`No image bytes for photo ${photoId}`)

  const model = await clipModel()
  const result = await encodeImage(loaded.buffer, loaded.filename, model)
  const db = useDB()
  db.insert(tables.photoEmbeddings)
    .values({
      photoId,
      model: result.model,
      embedding: float32ToBuffer(result.embedding),
      dim: result.dim,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tables.photoEmbeddings.photoId,
      set: {
        model: result.model,
        embedding: float32ToBuffer(result.embedding),
        dim: result.dim,
        updatedAt: new Date(),
      },
    })
    .run()

  log().success(`CLIP embedding stored for ${photoId} (${result.dim}-d)`)
}

export interface SmartSearchHit {
  photoId: string
  distance: number
  score: number
  source: 'clip' | 'ocr'
}

function cleanQuery(raw: string) {
  return raw.replace(/\s+/g, ' ').trim()
}

/** Public smart search: CLIP (+ optional OCR merge). */
export async function searchSmart(
  query: string,
  options?: { limit?: number; includeOcr?: boolean },
): Promise<SmartSearchHit[]> {
  if (!(await isClipEnabled())) {
    throw createError({ statusCode: 503, message: 'Smart search is disabled' })
  }
  const q = cleanQuery(query)
  if (!q) return []

  const model = await clipModel()
  let textEmb: number[]
  try {
    textEmb = (await encodeText(q, model)).embedding
  } catch (err) {
    if (err instanceof MlUnavailableError) {
      throw createError({ statusCode: 503, message: err.message })
    }
    throw err
  }

  const queryVec = Float32Array.from(textEmb)
  const db = useDB()
  const rows = db
    .select()
    .from(tables.photoEmbeddings)
    .where(eq(tables.photoEmbeddings.model, model))
    .all()
  const limit = options?.limit ?? (await clipTopK())
  const minScore = await clipMinScore()
  const scored: SmartSearchHit[] = []

  for (const row of rows) {
    if (row.dim && queryVec.length && row.dim !== queryVec.length) continue
    const photo = db
      .select({ id: tables.photos.id, deletedAt: tables.photos.deletedAt })
      .from(tables.photos)
      .where(eq(tables.photos.id, row.photoId))
      .get()
    if (!photo || photo.deletedAt) continue

    const emb = bufferToFloat32(row.embedding as Buffer)
    const distance = cosineDistance(queryVec, emb)
    scored.push({
      photoId: row.photoId,
      distance,
      score: 1 - distance,
      source: 'clip',
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]?.score ?? 0
  // Drop weak neighbors. A hit must clear the absolute floor and stay
  // close to the best match, so an unrelated query does not fill the page.
  const clipHits = scored
    .filter((hit, index) => {
      if (hit.score < minScore) return false
      if (index === 0) return true
      return hit.score >= best - 0.08
    })
    .slice(0, Math.max(1, limit))

  if (options?.includeOcr !== false) {
    try {
      const ocrIds = await searchOcr(q, limit)
      const seen = new Set(clipHits.map((h) => h.photoId))
      for (const id of ocrIds) {
        if (clipHits.length >= limit) break
        if (seen.has(id)) continue
        clipHits.push({
          photoId: id,
          distance: 0.99,
          score: 0.01,
          source: 'ocr',
        })
        seen.add(id)
      }
    } catch {
      /* OCR optional */
    }
  }

  return clipHits
}
