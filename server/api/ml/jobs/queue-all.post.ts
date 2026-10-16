import { eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  queueRecognitionSweep,
  resetMlPersonClustering,
} from '~~/server/services/ml/face-recognition.service'
import {
  beginFaceReindex,
  noteFaceReindexJobFinished,
} from '~~/server/services/ml/face-reindex'
import {
  clipModel,
  isClipEnabled,
  isFaceEnabled,
  isOcrEnabled,
} from '~~/server/services/ml/config'

export default eventHandler(async (event) => {

  const body = await readValidatedBody(
    event,
    z
      .object({
        type: z.enum(['clip', 'faces', 'ocr', 'recognition', 'all']),
        mode: z.enum(['missing', 'all']).default('missing'),
      })
      .parse,
  )

  const pool = globalThis.__workerPool
  if (!pool?.addTask) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Worker pool not initialized',
    })
  }

  const db = useDB()
  // Images only — videos are not run through CLIP / faces / OCR.
  const allIds = db
    .select({ id: tables.photos.id, type: tables.photos.type })
    .from(tables.photos)
    .where(isNull(tables.photos.deletedAt))
    .all()
    .filter((p) => p.type !== 'video')
    .map((p) => p.id)

  let enqueued = 0
  const errors: string[] = []

  const enqueueTyped = async (
    photoId: string,
    type: 'photo-smart-search' | 'photo-face-detection' | 'photo-ocr',
    extra?: { reindexBatch?: boolean },
  ) => {
    try {
      await pool.addTask(
        { type, photoId, ...extra },
        { priority: 0, maxAttempts: 3 },
      )
      enqueued++
    } catch (err) {
      errors.push(
        `${photoId}/${type}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const idsMissingEmbedding = async (): Promise<string[]> => {
    // Match smart-search filter: only the current CLIP model counts as done.
    const model = await clipModel()
    const have = new Set(
      db
        .select({ id: tables.photoEmbeddings.photoId })
        .from(tables.photoEmbeddings)
        .where(eq(tables.photoEmbeddings.model, model))
        .all()
        .map((r) => r.id),
    )
    return allIds.filter((id) => !have.has(id))
  }

  const idsMissingFaces = (): string[] => {
    // photo_face_scans is written even when detection finds 0 faces.
    const have = new Set(
      db
        .select({ id: tables.photoFaceScans.photoId })
        .from(tables.photoFaceScans)
        .all()
        .map((r) => r.id),
    )
    return allIds.filter((id) => !have.has(id))
  }

  const idsMissingOcr = (): string[] => {
    const have = new Set(
      db
        .select({ id: tables.photoOcr.photoId })
        .from(tables.photoOcr)
        .all()
        .map((r) => r.id),
    )
    return allIds.filter((id) => !have.has(id))
  }

  const resolveIds = async (
    kind: 'clip' | 'faces' | 'ocr',
  ): Promise<string[]> => {
    if (body.mode === 'all') return allIds
    if (kind === 'clip') return idsMissingEmbedding()
    if (kind === 'faces') return idsMissingFaces()
    return idsMissingOcr()
  }

  const wantFaces = body.type === 'faces' || body.type === 'all'
  const wantRecognition =
    body.type === 'recognition' || body.type === 'all'

  // True while detections from a full face reindex are still outstanding.
  // Recognition is then triggered by the last finished detection job.
  let deferRecognitionForReindex = false

  if (body.type === 'clip' || body.type === 'all') {
    if (await isClipEnabled()) {
      for (const id of await resolveIds('clip')) {
        await enqueueTyped(id, 'photo-smart-search')
      }
    }
  }

  if (wantFaces && (await isFaceEnabled())) {
    const faceIds = await resolveIds('faces')

    if (body.mode === 'all') {
      try {
        resetMlPersonClustering()
      } catch (err) {
        errors.push(
          `reset-clustering: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      if (faceIds.length > 0) {
        // Set barrier before enqueue so workers cannot race recognition early.
        beginFaceReindex(faceIds.length)
        deferRecognitionForReindex = true
        let enqueueFailed = 0
        for (const id of faceIds) {
          try {
            await pool.addTask(
              {
                type: 'photo-face-detection',
                photoId: id,
                reindexBatch: true,
              },
              { priority: 0, maxAttempts: 3 },
            )
            enqueued++
          } catch (err) {
            enqueueFailed++
            errors.push(
              `${id}/photo-face-detection: ${err instanceof Error ? err.message : String(err)}`,
            )
            // Count failed enqueues as finished so the barrier can still clear.
            if (noteFaceReindexJobFinished()) {
              deferRecognitionForReindex = false
            }
          }
        }
        if (enqueueFailed === faceIds.length) {
          deferRecognitionForReindex = false
        }
      }
    } else {
      for (const id of faceIds) {
        await enqueueTyped(id, 'photo-face-detection')
      }
    }
  }

  if (body.type === 'ocr' || body.type === 'all') {
    if (await isOcrEnabled()) {
      for (const id of await resolveIds('ocr')) {
        await enqueueTyped(id, 'photo-ocr')
      }
    }
  }

  // Recognition now only when not waiting on a full-reindex detection batch.
  // (Batch completion queues a sweep in face-detection.service.)
  // For mode=all with zero photos, still sweep so clustering can run on
  // whatever faces already exist after reset.
  if (wantRecognition && (await isFaceEnabled()) && !deferRecognitionForReindex) {
    try {
      await queueRecognitionSweep()
      enqueued++
    } catch (err) {
      errors.push(
        `recognition: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    success: errors.length === 0,
    type: body.type,
    mode: body.mode,
    enqueued,
    photoCount: allIds.length,
    errors: errors.length ? errors.slice(0, 50) : undefined,
  }
})
