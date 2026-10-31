import { alignSessionSetCookies } from '../utils/session-cookie'
import { useSecureCookie } from '../utils/cookie-security'

/** 登出写在 nuxt-auth-utils 内部，无法把 cookie.secure 传进去，只能在响应发出前改 Set-Cookie。 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event) => {
    const current = getResponseHeader(event, 'set-cookie')
    const sessionName =
      (useRuntimeConfig(event) as { session?: { name?: string } }).session
        ?.name || 'nuxt-session'
    const next = alignSessionSetCookies(
      current as string | string[] | number | undefined,
      sessionName,
      useSecureCookie(event),
    )
    if (!next) return
    const previous = (Array.isArray(current) ? current : [current]).map(String)
    if (
      next.length === previous.length &&
      next.every((cookie, i) => cookie === previous[i])
    ) {
      return
    }
    setResponseHeader(event, 'set-cookie', next)
  })
})
