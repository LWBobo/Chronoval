import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { detectFaces, MlUnavailableError } from './client'
import { faceMinScore, faceModel, isFaceEnabled } from './config'
import { noteFaceReindexJobFinished } from './face-reindex'
import { withFaceDetectLimit } from './limit'
import { loadPhotoImageBuffer } from './photo-image'
import { reconcilePeople } from './person.service'
import { float32ToBuffer, iou } from './vector'

const log = () => logger.dynamic('ml-face-detect')

function markFaceScan(photoId: string) {
  useDB()
    .update(tables.photos)
    .set({ faceScannedAt: new Date() })
    .where(eq(tables.photos.id, photoId))
    .run()
}

export async function processFaceDetection(
  photoId: string,
  options?: { reindexBatch?: boolean },
) {
  return withFaceDetectLimit(() =>
    processFaceDetectionUnlocked(photoId, options),
  )
}

async function processFaceDetectionUnlocked(
  photoId: string,
  options?: { reindexBatch?: boolean },
) {
  const partOfReindex = Boolean(options?.reindexBatch)
  try {
    await processFaceDetectionBody(photoId, partOfReindex)
  } finally {
    if (partOfReindex && noteFaceReindexJobFinished()) {
      try {
        const { queueRecognitionSweep } = await import(
          './face-recognition.service'
        )
        await queueRecognitionSweep()
      } catch (err) {
        log().warn('Failed to queue recognition after face reindex', err)
      }
    }
  }
}

async function processFaceDetectionBody(
  photoId: string,
  partOfReindex: boolean,
) {
  if (!(await isFaceEnabled())) {
    log().info(`Face ML disabled; skip ${photoId}`)
    return
  }

  const loaded = await loadPhotoImageBuffer(photoId)
  if (!loaded) throw new Error(`No image bytes for photo ${photoId}`)

  const minScore = await faceMinScore()
  const modelName = await faceModel()
  let result: Awaited<ReturnType<typeof detectFaces>>
  try {
    result = await detectFaces(
      loaded.buffer,
      minScore,
      loaded.filename,
      modelName,
    )
  } catch (err) {
    if (err instanceof MlUnavailableError) throw err
    throw err
  }

  const db = useDB()
  const photo = db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
  const width = result.width || photo?.width || 1
  const height = result.height || photo?.height || 1

  const existing = db
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.photoId, photoId))
    .all()
    .filter((f) => f.source === 'ml')

  const matchedExisting = new Set<string>()
  const newFaceIds: string[] = []
  const affectedPeople = new Set<string>()

  for (const face of result.faces) {
    const rel = {
      x1: face.bbox.x1 / width,
      y1: face.bbox.y1 / height,
      x2: face.bbox.x2 / width,
      y2: face.bbox.y2 / height,
    }
    // Clamp
    rel.x1 = Math.min(1, Math.max(0, rel.x1))
    rel.y1 = Math.min(1, Math.max(0, rel.y1))
    rel.x2 = Math.min(1, Math.max(0, rel.x2))
    rel.y2 = Math.min(1, Math.max(0, rel.y2))

    const hit = existing.find(
      (e) =>
        !matchedExisting.has(e.id) &&
        iou(rel, { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }) > 0.5,
    )

    if (hit) {
      matchedExisting.add(hit.id)
      db.update(tables.assetFaces)
        .set({
          x1: rel.x1,
          y1: rel.y1,
          x2: rel.x2,
          y2: rel.y2,
          imageWidth: width,
          imageHeight: height,
          score: face.score,
        })
        .where(eq(tables.assetFaces.id, hit.id))
        .run()
      db.insert(tables.faceEmbeddings)
        .values({
          faceId: hit.id,
          model: modelName,
          embedding: float32ToBuffer(face.embedding),
          dim: face.embedding.length,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: tables.faceEmbeddings.faceId,
          set: {
            model: modelName,
            embedding: float32ToBuffer(face.embedding),
            dim: face.embedding.length,
            updatedAt: new Date(),
          },
        })
        .run()
    } else {
      const id = randomUUID()
      db.insert(tables.assetFaces)
        .values({
          id,
          photoId,
          personId: null,
          x1: rel.x1,
          y1: rel.y1,
          x2: rel.x2,
          y2: rel.y2,
          imageWidth: width,
          imageHeight: height,
          score: face.score,
          source: 'ml',
        })
        .run()
      db.insert(tables.faceEmbeddings)
        .values({
          faceId: id,
          model: modelName,
          embedding: float32ToBuffer(face.embedding),
          dim: face.embedding.length,
          updatedAt: new Date(),
        })
        .run()
      newFaceIds.push(id)
    }
  }

  // Remove stale ML faces not re-detected; refresh people that lost faces.
  for (const old of existing) {
    if (!matchedExisting.has(old.id)) {
      if (old.personId) affectedPeople.add(old.personId)
      db.delete(tables.assetFaces).where(eq(tables.assetFaces.id, old.id)).run()
    }
  }
  reconcilePeople(affectedPeople)

  // Sentinel so "queue missing" does not re-run photos with 0 faces forever.
  markFaceScan(photoId)
  const { anchorManualMembers } = await import('./person.service')
  await anchorManualMembers(photoId)

  log().success(
    `Faces for ${photoId}: ${result.faces.length} detected, ${newFaceIds.length} new`,
  )

  // During a full reindex batch, wait until all detections finish, then one sweep.
  if (partOfReindex) return

  // One sweep covers new + existing unassigned faces; avoid per-face fan-out.
  if (newFaceIds.length > 0 || result.faces.length > 0) {
    const { queueRecognitionSweep } = await import('./face-recognition.service')
    await queueRecognitionSweep()
  }
}
