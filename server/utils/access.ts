import type { H3Event } from 'h3'
import type { SessionUser } from './auth'
import { toSessionUser } from './auth'
import { resolveApiAccess, type AccessLevel } from './access-policy'
import { eq } from 'drizzle-orm'

export function resolveAccess(method: string, pathname: string): AccessLevel {
  return resolveApiAccess(method, pathname)
}

/**
 * 接口身份只分三档，由 server/middleware/access.ts 统一执行。
 * 未登记的 /api 路由默认 admin，新增接口不会默认公开。
 *
 * - public  访客（首页画廊、公开相簿、登录）
 * - user    任意已登录用户（资料、两步验证、自己的登入记录）
 * - admin   管理员（后台写操作与管理数据）
 *
 * 同一接口里「管理员多看一些字段」仍走 public/user，处理函数用 getActor 分支。
 */
export type Actor = {
  user: SessionUser | null
  isAdmin: boolean
}

export async function getActor(event: H3Event): Promise<Actor> {
  const session = await getUserSession(event).catch(() => null)
  const sessionUser = (session?.user ?? null) as SessionUser | null
  const userId = Number(sessionUser?.id)
  const row = Number.isFinite(userId)
    ? useDB()
        .select()
        .from(tables.users)
        .where(eq(tables.users.id, userId))
        .get()
    : null
  const user = row && row.status === 'active' && row.authVersion === sessionUser?.authVersion ? toSessionUser(row) : null

  if (sessionUser && !user) {
    await clearUserSession(event).catch(() => undefined)
  }
  const actor = {
    user,
    isAdmin: user?.role === 'admin',
  }
  event.context.permissionActor = actor
  event.context.permissionSessionKey = session?.csrfToken ? `${user?.id ?? 'guest'}:${user?.authVersion ?? 0}:${session.csrfToken}` : null
  return actor
}

export async function requireAccess(
  event: H3Event,
  level: AccessLevel,
): Promise<Actor> {
  if (level === 'public') return getActor(event)
  const actor = await getActor(event)
  if (!actor.user) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Authentication required',
    })
  }
  if (level === 'admin' && !actor.isAdmin) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Admin privileges required',
    })
  }
  const path = getRequestURL(event).pathname
  if (actor.user.mustChangePassword && !/^\/api\/(?:me\/(?:password|profile)|profile|auth\/(?:csrf|2fa\/status)|logout|_auth\/session)$/.test(path)) {
    throw createError({ statusCode: 403, message: '请先修改初始密码', data: { code: 'PASSWORD_CHANGE_REQUIRED' } })
  }
  return actor
}
