import { z } from 'zod'

const _invalidChallengeOrCode = createError({
  statusCode: 401,
  message: 'Invalid verification code or challenge expired',
})

export default eventHandler(async (event) => {
  const db = useDB()
  const { code } = await readValidatedBody(
    event,
    z.object({ code: z.string().min(1).max(8) }).parse,
  )

  assertRateLimit(event, {
    namespace: 'login-2fa',
    limit: 10,
    windowMs: 10 * 60 * 1000,
  })

  const token = getCookie(event, totpConstants.CHALLENGE_COOKIE)
  if (!token) {
    throw _invalidChallengeOrCode
  }

  const challenge = verifyChallenge(token)
  if (!challenge) {
    throw _invalidChallengeOrCode
  }

  const user = db
    .select()
    .from(tables.users)
    .where(eq(tables.users.id, challenge.userId))
    .get()
  if (!user || user.status !== 'active' || user.authVersion !== challenge.authVersion || !user.totpEnabled || !user.totpSecret) {
    throw _invalidChallengeOrCode
  }

  if (!verifyTotp(user.totpSecret, code)) {
    recordLoginAttempt(event, {
      userId: user.id,
      email: user.email,
      method: 'two-factor',
      status: 'failed',
    })
    throw _invalidChallengeOrCode
  }

  if (!consumeChallenge(challenge)) {
    throw _invalidChallengeOrCode
  }
  db.transaction(tx => {
    const current = tx.select().from(tables.users).where(eq(tables.users.id, user.id)).get()
    if (!current || current.status !== 'active' || current.authVersion !== challenge.authVersion || current.totpSecret !== user.totpSecret || !current.totpEnabled) throw _invalidChallengeOrCode
    const inserted = tx.insert(tables.authChallengeUses).values({ nonce: challenge.nonce, userId: user.id, expiresAt: new Date(challenge.expiresAt * 1000) }).onConflictDoNothing().run()
    if (!inserted.changes) throw _invalidChallengeOrCode
  }, { behavior: 'immediate' })

  // 两步验证通过：把本条挑战记录转为成功登入
  markChallengeAsSucceeded(event, user.id, user.email)

  await establishUserSession(event, user)

  // 挑战一次性：签发正式会话后立即清除挑战 Cookie
  deleteCookie(event, totpConstants.CHALLENGE_COOKIE, { path: '/' })

  setResponseStatus(event, 201)
  return { authenticated: true }
})
