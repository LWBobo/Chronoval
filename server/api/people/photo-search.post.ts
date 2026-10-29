import { z } from 'zod'
import { searchPhotosForPerson } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({
      personId: z.string().min(1),
      q: z.string().optional().default(''),
      limit: z.number().int().min(1).max(80).optional(),
      cursor: z.string().max(500).optional().default(''),
    }).parse,
  )
  return searchPhotosForPerson(
    body.personId,
    body.q,
    body.limit ?? 48,
    body.cursor,
  )
})
