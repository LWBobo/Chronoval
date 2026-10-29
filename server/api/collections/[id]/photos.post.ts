import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { addPhotosToAlbums } from '~~/server/services/album-membership'
import { addPhotosToPerson } from '~~/server/services/ml/person.service'

/** 按集合种类写入成员。手工相簿进 collection_photos，人物相册进手动人脸行。 */
export default eventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) {
    throw createError({ statusCode: 400, message: 'Invalid collection' })
  }
  const body = await readValidatedBody(
    event,
    z.object({
      photoIds: z.array(z.string().min(1)).min(1).max(500),
    }).parse,
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
