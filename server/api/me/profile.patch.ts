import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
export default defineEventHandler(async (event) => {
  const { user } = await requireAccess(event, 'user')
  const input = await readValidatedBody(event, z.object({ displayName: z.string().trim().min(1).max(64) }).strict().parse)
  const result = useDB().update(tables.users).set({ displayName: input.displayName, version: sql`${tables.users.version}+1`, updatedAt: new Date() }).where(and(eq(tables.users.id, user!.id), eq(tables.users.status, 'active'), eq(tables.users.authVersion, user!.authVersion))).run()
  if (!result.changes) throw createError({ statusCode: 401, message: '请重新登录' })
  const current = useDB().select().from(tables.users).where(eq(tables.users.id, user!.id)).get()!
  await establishUserSession(event, current)
  return { displayName: input.displayName }
})
