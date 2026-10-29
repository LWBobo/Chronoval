import type { H3Event } from 'h3'

interface RateEntry {
  count: number
  resetAt: number
}

const buckets = new Map<string, RateEntry>()
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
let nextSweepAt = Date.now() + SWEEP_INTERVAL_MS

function normalizeAddress(value: string): string {
  return value.replace(/^::ffff:/, '').trim().toLowerCase()
}

function trustedProxyAddresses(): Set<string> {
  return new Set(
    (process.env.NUXT_TRUST_PROXY_IPS || '')
      .split(',')
      .map(normalizeAddress)
      .filter(Boolean),
  )
}

function requestIdentity(event: H3Event): string {
  const peer = normalizeAddress(
    event.node.req.socket.remoteAddress || 'unknown',
  )
  if (!trustedProxyAddresses().has(peer)) return peer

  // 只有明确登记的反向代理才允许提供客户端地址，避免直接访问应用端口时
  // 伪造 X-Forwarded-For 绕过登录与相簿密码限速。
  return normalizeAddress(
    getRequestIP(event, { xForwardedFor: true }) || peer,
  )
}

function sweepExpiredBuckets(now: number): void {
  if (now < nextSweepAt) return
  nextSweepAt = now + SWEEP_INTERVAL_MS
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key)
  }
}

export function assertRateLimit(
  event: H3Event,
  options: {
    namespace: string
    subject?: string
    limit: number
    windowMs: number
  },
): void {
  const now = Date.now()
  sweepExpiredBuckets(now)
  const key = `${options.namespace}:${requestIdentity(event)}:${options.subject || ''}`
  const current = buckets.get(key)

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs })
    return
  }

  current.count += 1
  if (current.count <= options.limit) return

  const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  setResponseHeader(event, 'Retry-After', String(retryAfter))
  throw createError({
    statusCode: 429,
    statusMessage: 'Too many attempts',
  })
}
