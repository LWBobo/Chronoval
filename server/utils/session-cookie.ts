/**
 * 登录会按当前协议决定 Cookie 的 Secure，HTTP 下不带 Secure。
 * h3 清除会话时却始终按 secure: true 写 Set-Cookie，浏览器在 HTTP 页面会丢掉这条响应，
 * 原来的 nuxt-session 还在，刷新后仍是登录态。
 * 这里把即将发出的会话 Cookie 改成与本次请求一致，并让空值带上 Max-Age=0，真正删掉旧 Cookie。
 */
export function alignSessionSetCookie(
  cookie: string,
  sessionName: string,
  secure: boolean,
): string {
  const prefix = `${sessionName}=`
  if (!cookie.startsWith(prefix)) return cookie

  const secureAttr = /;\s*Secure\b/gi
  let next = secure
    ? secureAttr.test(cookie)
      ? cookie
      : `${cookie}; Secure`
    : cookie.replace(secureAttr, '')

  const attributes = next.slice(prefix.length)
  const value = attributes.split(';', 1)[0] ?? ''
  if (value === '' && !/;\s*Max-Age=/i.test(next)) {
    next = `${prefix}; Max-Age=0${attributes}`
  }
  return next
}

export function alignSessionSetCookies(
  header: string | string[] | number | undefined | null,
  sessionName: string,
  secure: boolean,
): string[] | undefined {
  if (header == null || header === '') return undefined
  const cookies = (Array.isArray(header) ? header : [String(header)]).filter(
    (cookie) => cookie !== '',
  )
  if (cookies.length === 0) return undefined
  return cookies.map((cookie) =>
    alignSessionSetCookie(cookie, sessionName, secure),
  )
}
