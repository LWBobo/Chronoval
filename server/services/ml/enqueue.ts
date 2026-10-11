import { eq } from 'drizzle-orm'
import {
  isClipEnabled,
  isFaceEnabled,
  isOcrEnabled,
} from './config'

const log = () => logger.dynamic('ml-enqueue')

/** After a photo is indexed (upload pipeline or library scan), enqueue ML jobs. */
export async function enqueueMlJobsForPhoto(
  photoId: string,
  options?: { priority?: number },
) {
  const pool = globalThis.__workerPool
  if (!pool?.addTask) {
    log().warn(`WorkerPool unavailable; skip ML enqueue for ${photoId}`)
    return
  }

  const photo = useDB()
    .select({
      type: tables.photos.type,
      deletedAt: tables.photos.deletedAt,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo || photo.deletedAt) {
    log().info(`Skip ML enqueue for missing/trashed photo ${photoId}`)
    return
  }
  // Videos only have a still frame thumbnail; CLIP/faces/OCR are image pipelines.
  if (photo.type === 'video') {
    log().info(`Skip ML enqueue for video ${photoId}`)
    return
  }

  const priority = options?.priority ?? 0
  const jobs: Array<{ type: string; photoId?: string; faceId?: string }> = []

  if (await isClipEnabled()) {
    jobs.push({ type: 'photo-smart-search', photoId })
  }
  if (await isFaceEnabled()) {
    jobs.push({ type: 'photo-face-detection', photoId })
  }
  if (await isOcrEnabled()) {
    jobs.push({ type: 'photo-ocr', photoId })
  }

  for (const payload of jobs) {
    try {
      await pool.addTask(payload, { priority, maxAttempts: 3 })
    } catch (err) {
      log().warn(`Failed to enqueue ${payload.type} for ${photoId}`, err)
    }
  }
}
