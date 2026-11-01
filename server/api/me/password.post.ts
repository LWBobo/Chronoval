import { z } from 'zod'
import { passwordSchema, audit } from '../../services/users'
export default defineEventHandler(async (event) => {
  const actor = await requireAccess(event, 'user')
  const { oldPassword, password } = await readValidatedBody(event, z.object({ oldPassword: z.string().min(1).max(128), password: passwordSchema }).strict().parse)
  const row = useDB().select().from(tables.users).where(eq(tables.users.id, actor.user!.id)).get()!
  assertRateLimit(event, { namespace: 'change-password', subject: String(row.id), limit: 10, windowMs: 15 * 60 * 1000 })
  if (!(await verifyPassword(row.password || '', oldPassword))) throw createError({ statusCode: 400, message: '原密码不正确' })
  const hash = await hashPassword(password)
  const next = useDB().transaction((tx) => {
    const current = tx.select().from(tables.users).where(eq(tables.users.id, row.id)).get()!
    if (current.authVersion !== row.authVersion || current.status !== 'active') throw createError({ statusCode: 409, message: '账号状态已改变，请重新登录' })
    const updated = tx.update(tables.users).set({ password: hash, mustChangePassword: false, authVersion: current.authVersion + 1, version: current.version + 1, updatedAt: new Date() }).where(eq(tables.users.id, row.id)).returning().get()!
    audit(tx as any, row.id, 'user.change-password', 'user', row.id)
    return updated
  }, { behavior: 'immediate' })
  await establishUserSession(event, next)
  return { success: true }
})
