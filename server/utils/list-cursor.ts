import { createHash } from 'node:crypto'

export function listFingerprint(value: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}
export function encodeListCursor(fingerprint: string, position: Record<string, string | number>) {
  return Buffer.from(JSON.stringify({ fingerprint, position })).toString('base64url')
}
export function decodeListCursor(input: unknown, fingerprint: string): Record<string, string | number> | null {
  if (input === undefined || input === '') return null
  try {
    if (typeof input !== 'string' || input.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error()
    const cursor = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'))
    if (cursor.fingerprint !== fingerprint || !cursor.position || Array.isArray(cursor.position) || typeof cursor.position !== 'object') throw new Error()
    return cursor.position
  } catch { throw createError({ statusCode: 422, message: '分页位置与当前筛选不匹配，请重新加载' }) }
}
export function listLimit(input: unknown, max = 100) {
  if (input === undefined) return 50
  const value = Number(input)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw createError({ statusCode: 422, message: `每页数量须为 1–${max} 的整数` })
  return value
}
