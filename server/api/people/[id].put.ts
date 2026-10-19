import { z } from 'zod'
import { updatePerson, personWithMeta } from '~~/server/services/ml/person.service'

const visibilitySchema = z.enum(['public', 'login', 'admin'])

export default eventHandler(async (event) => {

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'Missing person id' })
  }

  const body = await readValidatedBody(
    event,
    z
      .object({
        name: z.string().nullable().optional(),
        isHidden: z.boolean().optional(),
        visibility: visibilitySchema.optional(),
        thumbnailFaceId: z.string().nullable().optional(),
      })
      .parse,
  )

  const person = updatePerson(id, {
    name: body.name,
    isHidden: body.isHidden,
    visibility: body.visibility,
    thumbnailFaceId: body.thumbnailFaceId,
  })

  if (!person) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }

  return { person: personWithMeta(person) }
})
