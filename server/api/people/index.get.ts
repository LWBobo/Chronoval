import {
  listPeople,
  personWithMeta,
} from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const query = getQuery(event)
  const rawMin = query.minFaces
  const parsedMin =
    rawMin === undefined || rawMin === '' || rawMin === null
      ? 1
      : Number(rawMin)
  const minFaces = Number.isFinite(parsedMin) ? Math.max(0, parsedMin) : 1

  const session = await getUserSession(event).catch(() => null)
  const isAdmin = Boolean((session as any)?.user?.isAdmin)
  const includeHidden =
    isAdmin &&
    (query.includeHidden === '1' ||
      query.includeHidden === 'true' ||
      query.includeHidden === true)

  const people = listPeople({ includeHidden, minFaces }).map(personWithMeta)
  return { people }
})
