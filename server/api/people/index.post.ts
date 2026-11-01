import { z } from 'zod'
import { createPerson } from '~~/server/services/ml/person.service'
import { collectionAccessSchema, replaceCollectionPolicy } from '../../services/collections/access'
import { assertCurrentActor } from '../../services/users'

/** 不依赖人脸检测，直接新建一本人物相册。 */
export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(
    event,
    z.object({
      name: z.string().trim().min(1).max(80),
      access: collectionAccessSchema.optional(),
    }).strict().parse,
  )
  const person = useDB().transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    const person = createPerson(body.name, { origin: 'manual' })
    if (person && body.access) replaceCollectionPolicy(person.collectionId!, body.access, actor, tx as any)
    return person
  }, { behavior: 'immediate' })
  if (!person) {
    throw createError({ statusCode: 500, message: 'Failed to create person' })
  }
  return { person }
})
