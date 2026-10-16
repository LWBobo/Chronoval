import { inArray } from 'drizzle-orm'
import {
  faceThumbnailUrl,
  listPeople,
} from '~~/server/services/ml/person.service'
import {
  canDiscoverPhoto,
  loadPhotoAccess,
} from '~~/server/utils/photo-access'

export default eventHandler(async (event) => {
  const query = getQuery(event)
  const rawMin = query.minFaces
  const parsedMin =
    rawMin === undefined || rawMin === '' || rawMin === null
      ? 1
      : Number(rawMin)
  const minFaces = Number.isFinite(parsedMin) ? Math.max(0, parsedMin) : 1

  const { isAdmin } = await getActor(event)
  const includeHidden =
    isAdmin &&
    (query.includeHidden === '1' ||
      query.includeHidden === 'true' ||
      query.includeHidden === true)

  const access = await loadPhotoAccess(event)
  const faces = useDB()
    .select({
      id: tables.assetFaces.id,
      personId: tables.assetFaces.personId,
      photoId: tables.assetFaces.photoId,
    })
    .from(tables.assetFaces)
    .all()
    .filter((face) => face.personId)
  const photoIds = [...new Set(faces.map((face) => face.photoId))]
  const visiblePhotos = new Set<string>()
  if (photoIds.length > 0) {
    const photos = useDB()
      .select({
        id: tables.photos.id,
        deletedAt: tables.photos.deletedAt,
        libraryMount: tables.photos.libraryMount,
        libraryPath: tables.photos.libraryPath,
      })
      .from(tables.photos)
      .where(inArray(tables.photos.id, photoIds))
      .all()
    for (const photo of photos) {
      if (canDiscoverPhoto(access, photo)) visiblePhotos.add(photo.id)
    }
  }

  const facesByPerson = new Map<string, { id: string; photoId: string }[]>()
  for (const face of faces) {
    if (!face.personId || !visiblePhotos.has(face.photoId)) continue
    const list = facesByPerson.get(face.personId)
    const item = { id: face.id, photoId: face.photoId }
    if (list) list.push(item)
    else facesByPerson.set(face.personId, [item])
  }

  const people = listPeople({ includeHidden, minFaces: 0 })
    .map((person) => {
      const visibleFaces = facesByPerson.get(person.id) || []
      if (
        visibleFaces.length < minFaces &&
        !(minFaces === 0 && person.name?.trim())
      ) {
        return null
      }
      if (visibleFaces.length === 0) return null
      const thumbnailFaceId = visibleFaces.some(
        (face) => face.id === person.thumbnailFaceId,
      )
        ? person.thumbnailFaceId
        : visibleFaces[0]?.id
      return {
        ...person,
        faceCount: visibleFaces.length,
        thumbnailFaceId,
        thumbnailUrl: faceThumbnailUrl(thumbnailFaceId),
      }
    })
    .filter((person) => person !== null)

  return { people }
})
