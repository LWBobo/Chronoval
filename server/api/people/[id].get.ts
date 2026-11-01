import {
  canSeePerson,
  faceThumbnailUrl,
  getPerson,
  getPersonPhotoIds,
  normalizeVisibility,
} from '~~/server/services/ml/person.service'
import { discoverablePhotoIds } from '~~/server/utils/photo-access'
import { collectionPasswordAccess } from '../../utils/collection-password'
import { isAlbumAdminBypass } from '../../utils/albumAccess'
import { withAssetUrlsBatch } from '../../services/media-files'

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
  const unlocked = collectionPasswordAccess(event, person.collectionId!, await isAlbumAdminBypass(event, actor))
  if (!unlocked) {
    return { person: { id: person.id, collectionId: person.collectionId, name: null, visibility, isHidden: visibility !== 'public', faceCount: 0, thumbnailUrl: null, locked: true }, photos: [] }
  }

  const personPhotos = getPersonPhotoIds(id)
  const visiblePhotoIds = await discoverablePhotoIds(
    event,
    personPhotos.map((photo) => photo.id),
  )
  const photos = withAssetUrlsBatch(personPhotos
    .filter((photo) => visiblePhotoIds.has(photo.id))
    , (photo) => actor.isAdmin || actor.user?.id === photo.ownerId)
    .map((photo) => toPublicPhoto(photo, actor.isAdmin || actor.user?.id === photo.ownerId))

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
      thumbnailUrl: faceThumbnailUrl(visibleFace?.id),
      locked: false,
    },
    photos,
  }
})
