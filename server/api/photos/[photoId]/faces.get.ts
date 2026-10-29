import { eq } from 'drizzle-orm'
import { canSeePerson, getFacesForPhoto } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 400, message: 'Missing photo id' })
  }

  await requireVisiblePhoto(event, photoId)

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
      ...face,
      personId,
      personName,
      thumbnailUrl: `/api/faces/${face.id}/thumbnail`,
    }
  })

  return { faces: result }
})
