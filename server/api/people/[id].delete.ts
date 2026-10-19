import { deletePeople, getPerson } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'Missing person id' })
  }
  if (!getPerson(id)) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }
  deletePeople([id])
  return { ok: true }
})
