import { timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { resolveSiteUrl } from './site-url'

export async function assertCsrf(event: H3Event) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(event.method)) return
  const session = await getUserSession(event)
  const expected = session.csrfToken
  const received = getRequestHeader(event, 'x-csrf-token') || ''
  if (!expected || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    throw createError({ statusCode: 403, message: '请求校验已失效，请刷新页面重试', data: { code: 'CSRF_INVALID' } })
  }
  const origin = getRequestHeader(event, 'origin')
  if (origin) {
    const configured = await resolveSiteUrl()
    // Match the host guard's explicit proxy allowlist before accepting forwarded origins.
    const normalizeAddress = (address: string) => address.replace(/^::ffff:/, '').trim().toLowerCase()
    const peer = normalizeAddress(event.node.req.socket.remoteAddress || '')
    const trustedProxies = new Set((process.env.NUXT_TRUST_PROXY_IPS || '').split(',').map(normalizeAddress).filter(Boolean))
    const trustForwarded = trustedProxies.has(peer)
    const allowed = new Set([getRequestURL(event, { xForwardedHost: trustForwarded, xForwardedProto: trustForwarded }).origin])
    if (configured) allowed.add(new URL(configured).origin)
    if (!allowed.has(origin)) throw createError({ statusCode: 403, message: 'Invalid request origin' })
  } else if (!session.user) {
    throw createError({ statusCode: 403, message: 'Request origin required' })
  }
}
