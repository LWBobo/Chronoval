import type { H3Event } from 'h3'
import { createChallengeToken, totpConstants } from './totp'
import { randomBytes } from 'node:crypto'
import { useSecureCookie } from './cookie-security'

/** 密码登录和 OAuth 完成第一步后共用；验证 TOTP 之前不建立正式登录会话。 */
export async function beginLoginChallenge(event: H3Event, userId: number, expectedAuthVersion: number) {
  const row = useDB().select().from(tables.users).where(eq(tables.users.id, userId)).get()
  if (!row || row.status !== 'active' || row.authVersion !== expectedAuthVersion) throw createError({ statusCode: 401, message: 'Invalid credentials' })
  const csrfToken = randomBytes(32).toString('hex')
  await replaceUserSession(event, { csrfToken }, { cookie: { secure: useSecureCookie(event) } })
  setHeader(event, 'X-CSRF-Token', csrfToken)
  const { token, expiresAt } = createChallengeToken(userId, row.authVersion)
  setCookie(event, totpConstants.CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: useSecureCookie(event),
    path: '/',
    expires: expiresAt,
  })
}
