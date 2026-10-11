import { eq } from 'drizzle-orm'

/** ml_state key: remaining face-detection jobs in a full reindex batch. */
const REMAINING_KEY = 'face_reindex_remaining'

const log = () => logger.dynamic('ml-face-reindex')

/**
 * Start a full-face-reindex barrier. Recognition must wait until every
 * detection job in the batch has finished (success or failure).
 */
export function beginFaceReindex(remaining: number) {
  const db = useDB()
  const now = new Date()
  if (remaining <= 0) {
    clearFaceReindex()
    return
  }
  db.insert(tables.mlState)
    .values({
      key: REMAINING_KEY,
      value: String(remaining),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: tables.mlState.key,
      set: { value: String(remaining), updatedAt: now },
    })
    .run()
  log().info(`Face reindex barrier set: ${remaining} detection job(s)`)
}

export function clearFaceReindex() {
  useDB()
    .delete(tables.mlState)
    .where(eq(tables.mlState.key, REMAINING_KEY))
    .run()
}

export function isFaceReindexActive(): boolean {
  const row = useDB()
    .select()
    .from(tables.mlState)
    .where(eq(tables.mlState.key, REMAINING_KEY))
    .get()
  if (!row?.value) return false
  const n = Number(row.value)
  return Number.isFinite(n) && n > 0
}

/**
 * Atomically count down one finished detection job.
 * @returns true when the barrier just cleared (caller should queue recognition).
 */
export function noteFaceReindexJobFinished(): boolean {
  const db = useDB()
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(tables.mlState)
      .where(eq(tables.mlState.key, REMAINING_KEY))
      .get()
    if (!row?.value) return false

    const current = Number(row.value)
    if (!Number.isFinite(current) || current <= 0) {
      tx.delete(tables.mlState)
        .where(eq(tables.mlState.key, REMAINING_KEY))
        .run()
      return false
    }

    const next = current - 1
    if (next <= 0) {
      tx.delete(tables.mlState)
        .where(eq(tables.mlState.key, REMAINING_KEY))
        .run()
      log().info('Face reindex barrier cleared; recognition may run')
      return true
    }

    tx.update(tables.mlState)
      .set({ value: String(next), updatedAt: new Date() })
      .where(eq(tables.mlState.key, REMAINING_KEY))
      .run()
    return false
  })
}
