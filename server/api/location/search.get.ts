import { searchPlacesByName } from '~~/server/services/location/geocoding'

/** 按中文或其它语言地名搜索位置，供照片编辑选点。默认管理员。 */
export default eventHandler(async (event) => {
  const query = getQuery(event)
  const q = String(query.q || '').trim()
  if (!q) return { items: [] }
  if (q.length > 120) {
    throw createError({ statusCode: 400, message: 'Query too long' })
  }
  const limitRaw = Number(query.limit)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(30, Math.max(1, limitRaw))
    : 20
  const items = await searchPlacesByName(q, limit)
  return { items }
})
