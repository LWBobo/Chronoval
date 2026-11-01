/** Keep authentication redirects on local application pages. */
export function safeLoginRedirect(input: unknown, fallback: string) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || /[\\\x00-\x20]/.test(input)) return fallback
  try {
    const decoded = decodeURIComponent(input)
    if (decoded.startsWith('//') || /[\\\x00-\x20]/.test(decoded)) return fallback
    const target = new URL(input, 'https://local.invalid')
    if (target.origin !== 'https://local.invalid' || /^\/(?:login|signin|onboarding)(?:\/|$)/.test(target.pathname)) return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch { return fallback }
}
