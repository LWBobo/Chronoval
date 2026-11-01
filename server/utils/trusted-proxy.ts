import type { H3Event } from 'h3'

function normalizeAddress(value: string): string {
  return value.replace(/^::ffff:/, '').trim().toLowerCase()
}

/** 直连地址在 NUXT_TRUST_PROXY_IPS 中时，才采信该连接带来的转发头。 */
export function trustsForwardedHeaders(event: H3Event): boolean {
  const peer = normalizeAddress(event.node.req.socket?.remoteAddress || '')
  if (!peer) return false
  return (process.env.NUXT_TRUST_PROXY_IPS || '')
    .split(',')
    .map(normalizeAddress)
    .filter(Boolean)
    .includes(peer)
}
