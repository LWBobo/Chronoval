import { z } from 'zod'
import { reconcileStorageUsage } from '../../../../services/users/storage'

export default defineEventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const userId = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  const input = await readValidatedBody(event, z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict().parse)
  return reconcileStorageUsage(actor, userId, input)
})
