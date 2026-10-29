import path from 'node:path'

/**
 * Resolve an untrusted relative path below a fixed root.
 * Encoded path components must be decoded by the caller before this function.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const normalizedRoot = path.resolve(root)
  const normalizedRelative = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  const target = path.resolve(normalizedRoot, normalizedRelative)
  const relative = path.relative(normalizedRoot, target)

  if (!isRelativePathInsideRoot(relative)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' })
  }

  return target
}

/** 纯函数版本，供路径穿越回归测试复用。 */
export function isRelativePathInsideRoot(relative: string): boolean {
  return Boolean(
    relative &&
      relative !== '.' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
  )
}

export function isPathInsideRoot(root: string, relativePath: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedRelative = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  const target = path.resolve(normalizedRoot, normalizedRelative)
  return isRelativePathInsideRoot(path.relative(normalizedRoot, target))
}
