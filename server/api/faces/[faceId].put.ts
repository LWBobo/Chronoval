import { z } from 'zod'
import {
  createPerson,
  reassignFace,
} from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {

  const faceId = getRouterParam(event, 'faceId')
  if (!faceId) {
    throw createError({ statusCode: 400, message: 'Missing face id' })
  }

  const body = await readValidatedBody(
    event,
    z
      .object({
        personId: z.string().nullable().optional(),
        createPerson: z.boolean().optional(),
        name: z.string().nullable().optional(),
      })
      .parse,
  )

  let personId = body.personId ?? null
  if (body.createPerson) {
    const created = createPerson(body.name)
    if (!created) {
      throw createError({ statusCode: 500, message: 'Failed to create person' })
    }
    personId = created.id
  }

  const face = reassignFace(faceId, personId)
  return { face, personId }
})
