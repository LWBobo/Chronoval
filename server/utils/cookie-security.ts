import type { H3Event } from 'h3'
import { getRequestProtocol } from 'h3'
import { trustsForwardedHeaders } from './trusted-proxy'

/**
 * 显式 NUXT_COOKIE_SECURE 优先。
 * 否则只根据可信的外部协议决定 Secure：直连看 TLS，转发头仅在来源属于受信任代理时采信。
 */
export function useSecureCookie(event: H3Event): boolean {
  if (process.env.NUXT_COOKIE_SECURE === 'true') return true
  if (process.env.NUXT_COOKIE_SECURE === 'false') return false
  return getRequestProtocol(event, { xForwardedProto: trustsForwardedHeaders(event) }) === 'https'
}
