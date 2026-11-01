import { z } from 'zod'
import { startUserDeletion } from '../../../../services/users/deletion'
export default defineEventHandler(async event => {
  const input = await readValidatedBody(event, z.object({ expectedVersion: z.number().int().positive(), mode: z.enum(['transfer', 'purge']), targetUserId: z.number().int().positive().optional(), idempotencyKey: z.string().min(8).max(128), reason: z.string().trim().min(1).max(1000) }).strict().parse)
  const result = startUserDeletion(await requireAccess(event, 'admin'), Number(getRouterParam(event, 'id')), input)
  setResponseStatus(event, 202)
  return result
})
