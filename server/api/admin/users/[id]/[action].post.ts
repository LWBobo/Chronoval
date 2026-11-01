import { z } from 'zod'
import { accountAction, passwordSchema } from '../../../../services/users'
export default defineEventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const input = await readValidatedBody(event, z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000), password: passwordSchema.optional() }).strict().parse)
  return accountAction(Number(getRouterParam(event, 'id')), getRouterParam(event, 'action')!, input, actor)
})
