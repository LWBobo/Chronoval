import { beginLoginChallenge } from '~~/server/utils/login-challenge'
import { z } from 'zod'

const _invalidCredentialsError = createError({
  statusCode: 401,
  message: 'Invalid credentials',
})

export default eventHandler(async (event) => {
  const db = useDB()
  const { email, password } = await readValidatedBody(
    event,
    z.object({
      email: z.email(),
      password: z.string().min(6),
    }).parse,
  )

  assertRateLimit(event, {
    namespace: 'login-account',
    subject: email.trim().toLowerCase(),
    limit: 10,
    windowMs: 15 * 60 * 1000,
  })
  assertRateLimit(event, {
    namespace: 'login-ip',
    limit: 50,
    windowMs: 15 * 60 * 1000,
  })

  const user = db
    .select()
    .from(tables.users)
    .where(eq(tables.users.email, email))
    .get()

  if (!user) {
    recordLoginAttempt(event, { email, status: 'failed' })
    throw _invalidCredentialsError
  }

  if (!(await verifyPassword(user.password || '', password))) {
    recordLoginAttempt(event, { userId: user.id, email, status: 'failed' })
    throw _invalidCredentialsError
  }

  // 账号启用了两步验证：密码正确后不直接签发会话，而是下发短期签名的挑战 Cookie，
  // 前端需携带 TOTP 验证码走 /api/login/2fa 完成第二步后才建立正式会话。
  if (user.totpEnabled && user.totpSecret) {
    await beginLoginChallenge(event, user.id)
    // 密码校验通过、进入两步验证阶段：先记一条「待验证」记录，待 2FA 成功后转为成功
    recordLoginAttempt(event, { userId: user.id, email, status: 'challenge' })
    setResponseStatus(event, 202, 'Two-factor authentication required')
    return { requires2fa: true }
  }

  await setUserSession(
    event,
    { user: toSessionUser(user) },
    {
      cookie: {
        // secure: !useRuntimeConfig().allowInsecureCookie,
        secure: useSecureCookie(event),
      },
    },
  )

  recordLoginAttempt(event, { userId: user.id, email, status: 'success' })

  setResponseStatus(event, 201)
  return { authenticated: true }
})
