import { z } from 'zod'
import { addPhotosToPerson } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'Missing person id' })
  }
  const body = await readValidatedBody(
    event,
    z.object({ photoIds: z.array(z.string().min(1)).min(1).max(200) }).parse,
  )
  return addPhotosToPerson(id, body.photoIds)
})