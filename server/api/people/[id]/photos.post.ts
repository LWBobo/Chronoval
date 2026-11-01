import { z } from 'zod'
import { addPhotosToPerson } from '../../../services/ml/person.service'
import { membershipFields, mutateCollections, personCollectionIds, assertMembershipPhotos } from '../../../services/collections/mutations'
export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, z.object({ ...membershipFields, expectedAclVersion: z.number().int().positive() }).strict().parse)
  const [collectionId] = personCollectionIds([id])
  return mutateCollections(actor, [collectionId!], { [collectionId!]: body.expectedAclVersion }, body.reason, 'person.members-add', db => {
    assertMembershipPhotos(body.photoIds, db)
    return addPhotosToPerson(id, body.photoIds)
  })
})
