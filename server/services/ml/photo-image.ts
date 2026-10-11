import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { getGlobalStorageManager } from '../storage'

const ML_MAX_EDGE = 1280

/** Longest edge ≤ 1280 JPEG, so CLIP / faces / OCR see a bounded image. */
async function prepareMlImage(
  buffer: Buffer,
  filename: string,
): Promise<{ buffer: Buffer; filename: string }> {
  try {
    const out = await sharp(buffer, { failOn: 'none', animated: false })
      .rotate()
      .resize({
        width: ML_MAX_EDGE,
        height: ML_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92 })
      .toBuffer()
    const base = filename.replace(/\.[^.]+$/, '') || 'image'
    return { buffer: out, filename: `${base}.jpg` }
  } catch (err) {
    throw new Error(
      `Unable to prepare image for ML (${filename}): ${err instanceof Error ? err.message : err}`,
    )
  }
}
export async function loadPhotoImageBuffer(
  photoId: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  const db = useDB()
  const photo = db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
  if (!photo || photo.deletedAt) return null

  const storage = getGlobalStorageManager()
  if (!storage) return null

  let provider: { get: (key: string) => Promise<Buffer | null> }
  try {
    provider = storage.getProvider()
  } catch {
    return null
  }

  // Originals keep detail that a second pass over the thumbnail would lose.
  if (photo.source === 'library' && photo.libraryMount && photo.libraryPath) {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      // Common mount root used by compose
      const candidates = [
        join('/app/library', photo.libraryPath),
        join(process.cwd(), 'data/library', photo.libraryPath),
      ]
      for (const p of candidates) {
        try {
          const buf = await readFile(p)
          if (buf.length) {
            return prepareMlImage(
              buf,
              photo.libraryPath.split('/').pop() || `${photoId}.jpg`,
            )
          }
        } catch {
          /* next */
        }
      }
    } catch {
      /* ignore */
    }
  }

  const keys = [photo.storageKey, photo.thumbnailKey].filter(
    (k): k is string => Boolean(k),
  )
  for (const key of keys) {
    try {
      const buf = await provider.get(key)
      if (buf && buf.length > 0) {
        const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
        return prepareMlImage(raw, key.split('/').pop() || `${photoId}.jpg`)
      }
    } catch {
      /* try next */
    }
  }

  return null
}
