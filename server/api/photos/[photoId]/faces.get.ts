import { eq } from 'drizzle-orm'
import { getFacesForPhoto } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 400, message: 'Missing photo id' })
  }

  const faces = getFacesForPhoto(photoId)
  const db = useDB()

  const result = faces.map((face) => {
    let personName: string | null = null
    if (face.personId) {
      const person = db
        .select({ name: tables.people.name })
        .from(tables.people)
        .where(eq(tables.people.id, face.personId))
        .get()
      personName = person?.name ?? null
    }
    return {
      ...face,
      personName,
      thumbnailUrl: `/api/faces/${face.id}/thumbnail`,
    }
  })

  return { faces: result }
})
