import { z } from 'zod'
import { addPhotosToPerson } from '../../services/ml/person.service'
import { membershipFields, collectionVersionsSchema, mutateCollections, personCollectionIds, assertMembershipPhotos } from '../../services/collections/mutations'
export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(event, z.object({ personIds: z.array(z.string().min(1)).min(1).max(50), ...membershipFields, versions: collectionVersionsSchema }).strict().parse)
  const ids = [...new Set(body.personIds)]
  return mutateCollections(actor, personCollectionIds(ids), body.versions, body.reason, 'person.members-add', db => {
    assertMembershipPhotos(body.photoIds, db)
    let added = 0, already = 0
    for (const id of ids) { const result = addPhotosToPerson(id, body.photoIds); added += result.added; already += result.already }
    return { added, already, people: ids.length }
  })
})
