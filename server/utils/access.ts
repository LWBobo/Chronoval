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
  const user = row ? toSessionUser(row) : null

  if (sessionUser && !user) {
    await clearUserSession(event).catch(() => undefined)
  }
  return {
    user,
    isAdmin: user?.role === 'admin',
  }
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
  return actor
}
