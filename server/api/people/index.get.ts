import { inArray } from 'drizzle-orm'
import {
  faceThumbnailUrl,
  listPeople,
  normalizeVisibility,
  personWithMeta,
  photoCountByPerson,
  viewerFromActor,
  visibilityAllows,
} from '~~/server/services/ml/person.service'
import { discoverablePhotoIds } from '~~/server/utils/photo-access'

export default eventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const query = getQuery(event)
  const rawMin = query.minFaces
  const parsedMin =
    rawMin === undefined || rawMin === '' || rawMin === null
      ? 1
      : Number(rawMin)
  const minFaces = Number.isFinite(parsedMin) ? Math.max(0, parsedMin) : 1

  const actor = await getActor(event)
  const viewer = viewerFromActor(actor)
  const manage =
    query.manage === '1' || query.manage === 'true' || query.manage === true
  if (manage) {
    if (!actor.isAdmin) {
      throw createError({
        statusCode: 403,
        message: 'Admin privileges required',
      })
    }
    const counts = photoCountByPerson()
    const people = listPeople({ viewer: 'admin', minFaces: 0 }).map(
      (person) => ({
        ...personWithMeta(person),
        photoCount: counts.get(person.id) ?? 0,
      }),
    )
    return { people }
  }

  const faces = useDB()
    .select({
      id: tables.assetFaces.id,
      personId: tables.assetFaces.personId,
      photoId: tables.assetFaces.photoId,
      imageWidth: tables.assetFaces.imageWidth,
    })
    .from(tables.assetFaces)
    .all()
    .filter((face) => face.personId)
  const photoIds = [...new Set(faces.map((face) => face.photoId))]
  const visiblePhotos = await discoverablePhotoIds(event, photoIds)
  let photos: {
    id: string
    deletedAt: Date | null
    thumbnailUrl: string | null
    libraryMount: string | null
    libraryPath: string | null
  }[] = []
  if (photoIds.length > 0) {
    photos = useDB()
      .select({
        id: tables.photos.id,
        deletedAt: tables.photos.deletedAt,
        thumbnailUrl: tables.photos.thumbnailUrl,
        libraryMount: tables.photos.libraryMount,
        libraryPath: tables.photos.libraryPath,
      })
      .from(tables.photos)
      .where(inArray(tables.photos.id, photoIds))
      .all()
  }

  const thumbByPhoto = new Map(
    photos.map((photo) => [photo.id, photo.thumbnailUrl]),
  )
  const facesByPerson = new Map<
    string,
    { id: string; photoId: string; imageWidth: number }[]
  >()
  for (const face of faces) {
    if (!face.personId || !visiblePhotos.has(face.photoId)) continue
    const list = facesByPerson.get(face.personId)
    const item = {
      id: face.id,
      photoId: face.photoId,
      imageWidth: face.imageWidth,
    }
    if (list) list.push(item)
    else facesByPerson.set(face.personId, [item])
  }

  const people = listPeople({ viewer, minFaces: 0 })
    .map((person) => {
      const visibleFaces = facesByPerson.get(person.id) || []
      if (
        visibleFaces.length < minFaces &&
        !(minFaces === 0 && person.name?.trim())
      ) {
        return null
      }
      if (visibleFaces.length === 0) return null
      const cover = visibleFaces.find((face) => face.imageWidth > 0)
      const thumbnailFaceId = visibleFaces.some(
        (face) => face.id === person.thumbnailFaceId && face.imageWidth > 0,
      )
        ? person.thumbnailFaceId
        : (cover?.id ?? null)
      const visibility = normalizeVisibility(person)
      if (!visibilityAllows(visibility, viewer)) return null
      const memberPhotoIds = new Set(visibleFaces.map((face) => face.photoId))
      return {
        ...person,
        visibility,
        isHidden: visibility !== 'public',
        faceCount: memberPhotoIds.size,
        thumbnailFaceId,
        thumbnailUrl: thumbnailFaceId
          ? faceThumbnailUrl(thumbnailFaceId)
          : thumbByPhoto.get(visibleFaces[0]!.photoId) || null,
      }
    })
    .filter((person) => person !== null)

  return { people }
})
