import type { H3Event } from 'h3'
import { getRequestProtocol } from 'h3'

export function useSecureCookie(event: H3Event): boolean {
  if (process.env.NUXT_COOKIE_SECURE === 'true') return true
  if (process.env.NUXT_COOKIE_SECURE === 'false') return false
  return getRequestProtocol(event, { xForwardedProto: true }) === 'https'
}
