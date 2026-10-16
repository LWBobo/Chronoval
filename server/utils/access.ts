import type { H3Event } from 'h3'
import type { SessionUser } from './auth'

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
export type AccessLevel = 'public' | 'user' | 'admin'

export type Actor = {
  user: SessionUser | null
  isAdmin: boolean
}

interface AccessRule {
  methods?: string[]
  pattern: RegExp
  access: AccessLevel
}

const RULES: AccessRule[] = [
  { methods: ['POST'], pattern: /^\/api\/login$/, access: 'public' },
  { methods: ['POST'], pattern: /^\/api\/login\/2fa$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/logout$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/auth\/github$/, access: 'public' },
  { methods: ['GET', 'POST'], pattern: /^\/api\/auth\/2fa\/[^/]+$/, access: 'user' },
  { methods: ['GET'], pattern: /^\/api\/auth\/login-logs$/, access: 'user' },
  { methods: ['GET'], pattern: /^\/api\/profile$/, access: 'user' },

  // 首次安装时还没有管理员。是否仍处于安装阶段由 middleware 再查 firstLaunch。
  { pattern: /^\/api\/wizard(\/|$)/, access: 'public' },

  { methods: ['GET'], pattern: /^\/api\/photos$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/photos\/(visible|feed-status|reactions)$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/photos\/[^/]+\/(faces|albums)$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/photos\/[^/]+\/livephoto$/, access: 'user' },
  { pattern: /^\/api\/photos\/[^/]+\/reactions$/, access: 'public' },

  { methods: ['GET', 'POST'], pattern: /^\/api\/search\/smart$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/people$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/people\/[^/]+$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/faces\/[^/]+\/thumbnail$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/music\/[^/]+\/stream$/, access: 'public' },

  { methods: ['GET'], pattern: /^\/api\/albums$/, access: 'public' },
  { methods: ['GET', 'POST'], pattern: /^\/api\/albums\/scan\/[^/]+$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/albums\/scan-by-slug\/[^/]+$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/albums\/[^/]+$/, access: 'public' },
  { methods: ['POST'], pattern: /^\/api\/albums\/[^/]+\/unlock$/, access: 'public' },

  { methods: ['GET'], pattern: /^\/api\/system\/settings\/all$/, access: 'public' },
]

export function resolveAccess(method: string, pathname: string): AccessLevel {
  const m = method.toUpperCase()
  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(m)) continue
    if (rule.pattern.test(pathname)) return rule.access
  }
  return 'admin'
}

export async function getActor(event: H3Event): Promise<Actor> {
  const session = await getUserSession(event).catch(() => null)
  const user = (session?.user ?? null) as SessionUser | null
  return {
    user,
    isAdmin: Boolean(user?.isAdmin),
  }
}

export async function requireAccess(
  event: H3Event,
  level: AccessLevel,
): Promise<Actor> {
  if (level === 'public') return getActor(event)
  const session = await requireUserSession(event)
  const user = session.user as SessionUser
  const actor: Actor = {
    user,
    isAdmin: Boolean(user?.isAdmin),
  }
  if (level === 'admin' && !actor.isAdmin) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Admin privileges required',
    })
  }
  return actor
}
