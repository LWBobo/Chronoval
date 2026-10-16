import { querySmart, type SmartQueryMode } from '~~/server/services/ml/smart-query'

export default eventHandler(async (event) => {
  const query = getQuery(event)
  const q = String(query.q ?? query.query ?? '').trim()
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
  const modeRaw = String(query.mode ?? 'all').toLowerCase()
  const mode: SmartQueryMode =
    modeRaw === 'clip' || modeRaw === 'ocr' || modeRaw === 'all'
      ? modeRaw
      : 'all'

  const results = await querySmart({ event, q, limit, mode })
  return { query: q, results }
})
