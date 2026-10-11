import { z } from 'zod'
import { updatePerson, personWithMeta } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  await requireUserSession(event)

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
        thumbnailFaceId: z.string().nullable().optional(),
      })
      .parse,
  )

  const person = updatePerson(id, {
    name: body.name,
    isHidden: body.isHidden,
    thumbnailFaceId: body.thumbnailFaceId,
  })

  if (!person) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }

  return { person: personWithMeta(person) }
})
