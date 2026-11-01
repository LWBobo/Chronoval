import { z } from 'zod'
import { deletePeople } from '../../services/ml/person.service'
import { mutateCollections, personCollectionIds } from '../../services/collections/mutations'
export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin'), id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, z.object({ expectedAclVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict().parse)
  const [collectionId] = personCollectionIds([id])
  return mutateCollections(actor, [collectionId!], { [collectionId!]: body.expectedAclVersion }, body.reason, 'person.delete', () => { deletePeople([id]); return { ok: true } })
})
