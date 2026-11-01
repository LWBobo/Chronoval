import { z } from 'zod'
import { updatePerson, personWithMeta } from '~~/server/services/ml/person.service'
import { collectionAccessSchema, replaceCollectionPolicy } from '../../services/collections/access'
import { assertCurrentActor } from '../../services/users'

export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'Missing person id' })
  }

  const body = await readValidatedBody(
    event,
    z
      .object({
        name: z.string().nullable().optional(),
        access: collectionAccessSchema.optional(),
        thumbnailFaceId: z.string().nullable().optional(),
      })
      .strict()
      .parse,
  )

  const person = useDB().transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    const updated = updatePerson(id, {
    name: body.name,
    thumbnailFaceId: body.thumbnailFaceId,
    })
    if (updated && body.access) replaceCollectionPolicy(updated.collectionId!, body.access, actor, tx as any)
    return updated
  }, { behavior: 'immediate' })

  if (!person) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }

  return { person: personWithMeta(person) }
})
