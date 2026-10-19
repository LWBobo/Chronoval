import { eq } from 'drizzle-orm'
import { listPhotoTags, listTags } from '~~/server/services/ml/tags.service'

export default eventHandler((event) => {
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 400, statusMessage: 'Photo ID is required' })
  }
  const photo = useDB()
    .select({ id: tables.photos.id })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }
  return {
    assignments: listPhotoTags(photoId),
    catalog: listTags(),
  }
})
