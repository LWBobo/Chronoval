const USERNAME = /^[a-z][a-z0-9_-]{2,31}$/
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|clock\$)$/i

export function normalizeUsername(input: string): string {
  const value = input.trim().toLowerCase()
  if (!USERNAME.test(value) || RESERVED.test(value)) {
    throw new Error('用户名需为 3–32 位字母、数字、下划线或连字符，并以字母开头')
  }
  return value
}

export const normalizeEmail = (input: string) => input.trim().toLowerCase()

/** Names remain unchanged. Reject unsafe names rather than silently rewriting them. */
export function validateUploadPath(input: string): string {
  if (!input || input.length > 1024 || input.includes('\\') || input.startsWith('/')) {
    throw new Error('Invalid upload path')
  }
  const segments = input.split('/')
  if (segments.some((part) =>
    !part || part === '.' || part === '..' || part.length > 255 ||
    /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
    RESERVED.test(part.split('.')[0]!) || part.toLowerCase() === '.chronoval' ||
    part.toLowerCase() === '_duplicates',
  )) throw new Error('Invalid upload path')
  return segments.join('/')
}
