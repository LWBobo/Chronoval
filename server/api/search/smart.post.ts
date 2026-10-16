import { z } from 'zod'
import { querySmart } from '~~/server/services/ml/smart-query'

const bodySchema = z.object({
  q: z.string().default(''),
  limit: z.number().int().min(1).max(200).optional(),
  mode: z.enum(['all', 'clip', 'ocr']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  cameras: z.array(z.string()).optional(),
  lenses: z.array(z.string()).optional(),
  cities: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  minRating: z.number().optional(),
  albumId: z.number().int().positive().optional(),
})

export default eventHandler(async (event) => {
  const body = await readValidatedBody(event, bodySchema.parse)
  const results = await querySmart({
    event,
    q: body.q,
    limit: body.limit,
    mode: body.mode,
    filters: {
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      cameras: body.cameras,
      lenses: body.lenses,
      cities: body.cities,
      tags: body.tags,
      minRating: body.minRating,
      albumId: body.albumId,
    },
  })
  return { query: body.q.trim(), results }
})
