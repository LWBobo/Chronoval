import { retryUserDeletion } from '../../../../services/users/deletion'
import { z } from 'zod'
export default defineEventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const { reason } = await readValidatedBody(event, z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse)
  return retryUserDeletion(actor, getRouterParam(event, 'id')!, reason)
})
