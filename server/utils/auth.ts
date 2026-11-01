import type { users as usersTable } from '../database/schema'
import { useSecureCookie } from './cookie-security'

type UserRow = typeof usersTable.$inferSelect

/**
 * 从数据库用户行中取出可安全放进会话/回传给客户端的字段。
 * 一律剔除 password、totpSecret 等敏感项，避免通过会话或 /api/profile 泄露。
 */
export function toSessionUser(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    avatar: user.avatar,
    createdAt: user.createdAt,
    isAdmin: user.role === 'admin',
    role: user.role,
    authVersion: user.authVersion,
    mustChangePassword: user.mustChangePassword,
  }
}

export type SessionUser = ReturnType<typeof toSessionUser>

export async function establishUserSession(event: import('h3').H3Event, user: UserRow) {
  const { randomBytes } = await import('node:crypto')
  const csrfToken = randomBytes(32).toString('hex')
  const current = useDB().select().from(tables.users).where(eq(tables.users.id, user.id)).get()
  if (!current || current.status !== 'active' || current.authVersion !== user.authVersion) throw createError({ statusCode: 401, message: '账号状态已改变，请重新登录' })
  await replaceUserSession(event, { user: toSessionUser(user), csrfToken }, { cookie: { secure: useSecureCookie(event) } })
  setHeader(event, 'X-CSRF-Token', csrfToken)
}
