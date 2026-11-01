import { z } from 'zod'
import { addPhotosToAlbums } from '../../services/album-membership'
import { membershipFields, collectionVersionsSchema, mutateCollections, assertMembershipPhotos } from '../../services/collections/mutations'
export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(event, z.object({ albumIds: z.array(z.number().int().positive()).min(1).max(50), ...membershipFields, versions: collectionVersionsSchema }).strict().parse)
  return mutateCollections(actor, body.albumIds, body.versions, body.reason, 'collection.members-add', db => {
    assertMembershipPhotos(body.photoIds, db)
    return addPhotosToAlbums(body.albumIds, body.photoIds)
  })
})
