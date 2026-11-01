import { eq } from 'drizzle-orm'
import { canSeePerson, getFacesForPhoto } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 400, message: 'Missing photo id' })
  }

  const { photo } = await requireVisiblePhoto(event, photoId, { allowAdminDeleted: true })
  const version = photo.metadataVersion

  const actor = await getActor(event)
  const faces = getFacesForPhoto(photoId).filter(
    (face) => face.imageWidth > 0 && face.imageHeight > 0,
  )
  const db = useDB()

  const result = faces.map((face) => {
    let personName: string | null = null
    let personId = face.personId
    if (face.personId) {
      const person = db
        .select({
          name: tables.people.name,
          collectionId: tables.people.collectionId,
        })
        .from(tables.people)
        .where(eq(tables.people.id, face.personId))
        .get()
      if (!person || !canSeePerson(person, actor)) {
        personId = null
      } else {
        personName = person.name ?? null
      }
    }
    return {
      id: face.id, x1: face.x1, y1: face.y1, x2: face.x2, y2: face.y2, imageWidth: face.imageWidth, imageHeight: face.imageHeight,
      metadataVersion: actor.isAdmin ? version : undefined,
      personId,
      personName,
      thumbnailUrl: personId || actor.isAdmin || actor.user?.id === photo.ownerId ? `/api/faces/${face.id}/thumbnail` : null,
    }
  })

  return { faces: result }
})
