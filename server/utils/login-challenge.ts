import type { H3Event } from 'h3'
import { createChallengeToken, totpConstants } from './totp'

/** 密码登录和 OAuth 完成第一步后共用；验证 TOTP 之前不建立正式登录会话。 */
export async function beginLoginChallenge(event: H3Event, userId: number) {
  await clearUserSession(event)
  const { token, expiresAt } = createChallengeToken(userId)
  setCookie(event, totpConstants.CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: useSecureCookie(event),
    path: '/',
    expires: expiresAt,
  })
}
