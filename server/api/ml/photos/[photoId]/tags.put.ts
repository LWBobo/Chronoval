import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  listTags,
  setPhotoTagDecision,
  TagConflictError,
} from '~~/server/services/ml/tags.service'

const bodySchema = z.object({
  tagId: z.number().int().positive(),
  action: z.enum(['apply', 'reject', 'clear']),
})

export default eventHandler(async (event) => {
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

  const body = bodySchema.parse(await readBody(event))
  try {
    const assignments = await setPhotoTagDecision(
      photoId,
      body.tagId,
      body.action,
    )
    return { assignments, catalog: listTags() }
  } catch (err) {
    if (err instanceof TagConflictError) {
      throw createError({ statusCode: 409, statusMessage: err.message })
    }
    throw err
  }
})
