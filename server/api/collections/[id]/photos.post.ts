import { membershipFields, mutateCollections, assertMembershipPhotos } from '../../../services/collections/mutations'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { addPhotosToAlbums } from '~~/server/services/album-membership'
import { addPhotosToPerson } from '~~/server/services/ml/person.service'

/** 按集合种类写入成员。手工相簿进 collection_photos，人物相册进手动人脸行。 */
export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) {
    throw createError({ statusCode: 400, message: 'Invalid collection' })
  }
  const body = await readValidatedBody(
    event,
    z.object({
      ...membershipFields,
      expectedAclVersion: z.number().int().positive(),
    }).strict().parse,
  )
  const db = useDB()
  const collection = db
    .select()
    .from(tables.collections)
    .where(eq(tables.collections.id, id))
    .get()
  if (!collection) throw createError({ statusCode: 404, message: 'Collection not found' })
  if (collection.kind === 'folder') {
    throw createError({ statusCode: 400, message: 'Folder membership comes from the scan path' })
  }
  if (body.photoIds.length > 500) {
    throw createError({ statusCode: 400, message: 'Too many photos' })
  }
  return mutateCollections(actor, [id], { [id]: body.expectedAclVersion }, body.reason, 'collection.members-add', tx => {
  assertMembershipPhotos(body.photoIds, tx)
  if (collection.kind === 'manual') {
    return addPhotosToAlbums([id], body.photoIds)
  }
  const person = db
    .select({ id: tables.people.id })
    .from(tables.people)
    .where(eq(tables.people.collectionId, id))
    .get()
  if (!person) throw createError({ statusCode: 404, message: 'Person not found' })
  return addPhotosToPerson(person.id, body.photoIds)
  })
})
