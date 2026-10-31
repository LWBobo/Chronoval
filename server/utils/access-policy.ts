/**
 * API 路由访问策略。保持为无 Nuxt 运行时依赖的纯模块，便于用 Node 内置测试器
 * 覆盖公开接口、登录接口和默认拒绝规则。
 */
export type AccessLevel = 'public' | 'user' | 'admin'

interface AccessRule {
  methods?: string[]
  pattern: RegExp
  access: AccessLevel
}

const RULES: AccessRule[] = [
  // nuxt-auth-utils 内置：只读取/清除调用者自己的会话，普通账号与访客都需要。
  {
    methods: ['GET', 'DELETE'],
    pattern: /^\/api\/_auth\/session$/,
    access: 'public',
  },
  { methods: ['POST'], pattern: /^\/api\/login$/, access: 'public' },
  { methods: ['POST'], pattern: /^\/api\/login\/2fa$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/logout$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/auth\/github$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/auth\/2fa\/status$/, access: 'user' },
  {
    methods: ['POST'],
    pattern: /^\/api\/auth\/2fa\/(setup|confirm|disable)$/,
    access: 'user',
  },
  { methods: ['GET'], pattern: /^\/api\/auth\/login-logs$/, access: 'user' },
  { methods: ['GET'], pattern: /^\/api\/profile$/, access: 'user' },

  { pattern: /^\/api\/wizard(\/|$)/, access: 'public' },

  { methods: ['GET'], pattern: /^\/api\/assets\/[a-f0-9]+$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/photos$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/map\/photos$/, access: 'public' },
  {
    methods: ['GET'],
    pattern: /^\/api\/map\/photos\/[^/]+\/thumbnail$/,
    access: 'public',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/map\/cache\/touch$/,
    access: 'public',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/photos\/(visible|feed-status|reactions)$/,
    access: 'public',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/photos\/[^/]+\/(faces|albums)$/,
    access: 'public',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/photos\/[^/]+\/livephoto$/,
    access: 'public',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/photos\/[^/]+\/motion-video$/,
    access: 'public',
  },
  {
    methods: ['GET', 'POST', 'DELETE'],
    pattern: /^\/api\/photos\/[^/]+\/reactions$/,
    access: 'public',
  },

  {
    methods: ['GET', 'POST'],
    pattern: /^\/api\/search\/smart$/,
    access: 'public',
  },
  { methods: ['GET'], pattern: /^\/api\/people$/, access: 'public' },
  { methods: ['GET'], pattern: /^\/api\/people\/[^/]+$/, access: 'public' },
  {
    methods: ['GET'],
    pattern: /^\/api\/faces\/[^/]+\/thumbnail$/,
    access: 'public',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/music\/[^/]+\/stream$/,
    access: 'public',
  },

  { methods: ['GET'], pattern: /^\/api\/albums$/, access: 'public' },
  {
    methods: ['GET', 'POST'],
    pattern: /^\/api\/albums\/scan\/[^/]+$/,
    access: 'public',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/albums\/scan-by-slug\/[^/]+$/,
    access: 'public',
  },
  { methods: ['GET'], pattern: /^\/api\/albums\/[^/]+$/, access: 'public' },
  {
    methods: ['POST'],
    pattern: /^\/api\/albums\/[^/]+\/unlock$/,
    access: 'public',
  },

  {
    methods: ['GET'],
    pattern: /^\/api\/system\/settings\/all$/,
    access: 'public',
  },
]

export function resolveApiAccess(
  method: string,
  pathname: string,
): AccessLevel {
  const normalizedMethod =
    method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'
  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(normalizedMethod)) continue
    if (rule.pattern.test(normalizedPath)) return rule.access
  }
  return 'admin'
}
