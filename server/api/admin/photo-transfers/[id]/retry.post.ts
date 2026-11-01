import { z } from 'zod'
import { retryTransferCleanup } from '../../../../services/photo-management/transfer'

export default defineEventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const { reason } = await readValidatedBody(event, z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse)
  return retryTransferCleanup(actor, getRouterParam(event, 'id')!, reason)
})
