import {
  canSeePerson,
  faceThumbnailUrl,
  getPerson,
  getPersonPhotoIds,
  normalizeVisibility,
} from '~~/server/services/ml/person.service'
import { canDiscoverPhoto, loadPhotoAccess } from '~~/server/utils/photo-access'

export default eventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'Missing person id' })
  }

  const person = getPerson(id)
  if (!person) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }

  const actor = await getActor(event)
  if (!canSeePerson(person, actor)) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }
  const visibility = normalizeVisibility(person)

  const access = await loadPhotoAccess(event)
  const photos = getPersonPhotoIds(id)
    .filter((photo) => canDiscoverPhoto(access, photo))
    .map((p) => ({
      id: p.id,
      title: p.title,
      thumbnailUrl: p.thumbnailUrl,
      thumbnailHash: p.thumbnailHash,
      aspectRatio: p.aspectRatio,
      width: p.width,
      height: p.height,
      dateTaken: p.dateTaken,
      type: p.type,
    }))

  if (photos.length === 0 && !actor.isAdmin) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }

  const visibleFace = useDB()
    .select({ id: tables.assetFaces.id, photoId: tables.assetFaces.photoId })
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.personId, id))
    .all()
    .find((face) => photos.some((photo) => photo.id === face.photoId))

  return {
    person: {
      ...person,
      visibility,
      isHidden: visibility !== 'public',
      faceCount: photos.length,
      thumbnailUrl: faceThumbnailUrl(visibleFace?.id || person.thumbnailFaceId),
    },
    photos,
  }
})
