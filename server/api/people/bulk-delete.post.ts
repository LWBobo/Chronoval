import { z } from 'zod'
import { deletePeople } from '../../services/ml/person.service'
import { collectionVersionsSchema, mutateCollections, personCollectionIds } from '../../services/collections/mutations'
export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(event, z.object({ ids: z.array(z.string().min(1)).min(1).max(500), versions: collectionVersionsSchema, reason: z.string().trim().min(1).max(1000) }).strict().parse)
  return mutateCollections(actor, personCollectionIds(body.ids), body.versions, body.reason, 'person.delete', () => ({ deleted: deletePeople(body.ids) }))
})
