import { runOcr, MlUnavailableError } from './client'
import { isOcrEnabled } from './config'
import { withOcrLimit } from './limit'
import { loadPhotoImageBuffer } from './photo-image'

const log = () => logger.dynamic('ml-ocr')

export async function processOcr(photoId: string) {
  return withOcrLimit(() => processOcrUnlocked(photoId))
}

async function processOcrUnlocked(photoId: string) {
  if (!(await isOcrEnabled())) {
    log().info(`OCR disabled; skip ${photoId}`)
    return
  }

  const loaded = await loadPhotoImageBuffer(photoId)
  if (!loaded) throw new Error(`No image bytes for photo ${photoId}`)

  let result: Awaited<ReturnType<typeof runOcr>>
  try {
    result = await runOcr(loaded.buffer, loaded.filename)
  } catch (err) {
    if (err instanceof MlUnavailableError) throw err
    throw err
  }

  const text = (result.text || '').trim()
  const db = useDB()
  db.insert(tables.photoOcr)
    .values({
      photoId,
      text,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tables.photoOcr.photoId,
      set: { text, updatedAt: new Date() },
    })
    .run()

  try {
    const sqlite = useSqlite()
    sqlite.prepare('DELETE FROM photo_ocr_fts WHERE photo_id = ?').run(photoId)
    if (text) {
      sqlite
        .prepare('INSERT INTO photo_ocr_fts (photo_id, text) VALUES (?, ?)')
        .run(photoId, text)
    }
  } catch (err) {
    log().warn(`FTS update failed for ${photoId}`, err)
  }

  log().success(`OCR for ${photoId}: ${text.length} chars`)
}

export async function searchOcr(query: string, limit = 50): Promise<string[]> {
  const q = query.trim()
  if (!q) return []

  try {
    const sqlite = useSqlite()
    const rows = sqlite
      .prepare(
        'SELECT photo_id AS photoId FROM photo_ocr_fts WHERE photo_ocr_fts MATCH ? LIMIT ?',
      )
      .all(q, limit) as Array<{ photoId: string }>
    if (rows?.length) return rows.map((r) => r.photoId)
  } catch {
    /* LIKE fallback */
  }

  const lower = q.toLowerCase()
  return useDB()
    .select()
    .from(tables.photoOcr)
    .all()
    .filter((r) => r.text.toLowerCase().includes(lower))
    .slice(0, limit)
    .map((r) => r.photoId)
}
