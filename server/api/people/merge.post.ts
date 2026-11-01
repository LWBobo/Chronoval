import { collectionVersionsSchema, mutateCollections, personCollectionIds } from '../../services/collections/mutations'
import { z } from 'zod'
import { mergePeople, personWithMeta } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(
    event,
    z
      .object({
        targetId: z.string().min(1),
        sourceIds: z.array(z.string().min(1)).min(1).max(50),
        versions: collectionVersionsSchema,
        reason: z.string().trim().min(1).max(1000),
      })
      .strict().parse,
  )

  return mutateCollections(actor, personCollectionIds([body.targetId, ...body.sourceIds]), body.versions, body.reason, 'person.merge', () => {
    const person = mergePeople(body.targetId, body.sourceIds)
    return { person: personWithMeta(person!) }
  })
})
