import { deleteMlState, getMlState, setMlState } from './state'

const REMAINING_KEY = 'face_reindex_remaining'
const log = () => logger.dynamic('ml-face-reindex')

export function beginFaceReindex(remaining: number) {
  if (remaining <= 0) {
    clearFaceReindex()
    return
  }
  setMlState(REMAINING_KEY, String(remaining))
  log().info(`Face reindex barrier set: ${remaining} detection job(s)`)
}

export function clearFaceReindex() {
  deleteMlState(REMAINING_KEY)
}

export function isFaceReindexActive(): boolean {
  const value = getMlState(REMAINING_KEY)
  const remaining = Number(value)
  return Number.isFinite(remaining) && remaining > 0
}

export function noteFaceReindexJobFinished(): boolean {
  const db = useDB()
  return db.transaction(() => {
    const current = Number(getMlState(REMAINING_KEY))
    if (!Number.isFinite(current) || current <= 0) {
      clearFaceReindex()
      return false
    }
    const next = current - 1
    if (next <= 0) {
      clearFaceReindex()
      log().info('Face reindex barrier cleared; recognition may run')
      return true
    }
    setMlState(REMAINING_KEY, String(next))
    return false
  })
}
