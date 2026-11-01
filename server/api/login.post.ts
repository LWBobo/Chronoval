import { beginLoginChallenge } from '~~/server/utils/login-challenge'
import { z } from 'zod'
import { normalizeEmail } from '../utils/identity'

const _invalidCredentialsError = createError({
  statusCode: 401,
  message: 'Invalid credentials',
})

export default eventHandler(async (event) => {
  const db = useDB()
  const { identifier, password } = await readValidatedBody(
    event,
    z.object({
      identifier: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(128),
    }).strict().parse,
  )

  const key = normalizeEmail(identifier)
  const user = db.select().from(tables.users).where(key.includes('@') ? eq(tables.users.emailKey, key) : eq(tables.users.usernameKey, key)).get()
  const email = user?.email ?? null
  assertRateLimit(event, {
    namespace: 'login-account',
    subject: user ? String(user.id) : key,
    limit: 10,
    windowMs: 15 * 60 * 1000,
  })
  assertRateLimit(event, {
    namespace: 'login-ip',
    limit: 50,
    windowMs: 15 * 60 * 1000,
  })

  if (!user || user.status !== 'active') {
    recordLoginAttempt(event, { email, identifier: key, status: 'failed' })
    throw _invalidCredentialsError
  }

  if (!(await verifyPassword(user.password || '', password))) {
    recordLoginAttempt(event, { userId: user.id, email, identifier: key, status: 'failed' })
    throw _invalidCredentialsError
  }

  // 账号启用了两步验证：密码正确后不直接签发会话，而是下发短期签名的挑战 Cookie，
  // 前端需携带 TOTP 验证码走 /api/login/2fa 完成第二步后才建立正式会话。
  if (user.totpEnabled && user.totpSecret) {
    await beginLoginChallenge(event, user.id, user.authVersion)
    // 密码校验通过、进入两步验证阶段：先记一条「待验证」记录，待 2FA 成功后转为成功
    recordLoginAttempt(event, { userId: user.id, email, identifier: key, status: 'challenge' })
    setResponseStatus(event, 202, 'Two-factor authentication required')
    return { requires2fa: true }
  }

  await establishUserSession(event, user)

  recordLoginAttempt(event, { userId: user.id, email, identifier: key, status: 'success' })

  setResponseStatus(event, 201)
  return { authenticated: true }
})
