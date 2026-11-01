import { z } from 'zod'
import { normalizeEmail } from '../../../../utils/identity'
import { editAccount } from '../../../../services/users'
export default defineEventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const input = await readValidatedBody(event, z.object({ expectedVersion: z.number().int().positive(), displayName: z.string().trim().min(1).max(64).optional(), email: z.email().transform(normalizeEmail).optional(), canUpload: z.boolean().optional(), quotaBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(), role: z.enum(['admin', 'user']).optional(), reason: z.string().trim().min(1).max(1000) }).strict().parse)
  return editAccount(Number(getRouterParam(event, 'id')), input, actor)
})
