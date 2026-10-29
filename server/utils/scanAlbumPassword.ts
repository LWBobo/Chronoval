import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

/**
 * 相簿访问密码的哈希与校验。
 *
 * 新密码使用带随机盐的 scrypt-v1，提升弱密码面对离线字典攻击时的成本。
 *
 * 兼容性：
 * - `sha256$<hash>`           早前未加盐的 sha256（上一版写入）仍可校验
 * - `scrypt$…`                nuxt-auth-utils scrypt 历史密码仍可校验
 * - 重新设置密码后一律写入 `scrypt-v1$…` 格式
 */

const SHA_PREFIX = 'sha256$'
const SCRYPT_PREFIX = 'scrypt$'
const SCRYPT_V1_PREFIX = 'scrypt-v1$'

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex')

const safeEquals = (a: string, b: string): boolean => {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 新密码使用内存困难的 scrypt。旧 SHA-256 与 nuxt-auth-utils scrypt
 * 仅保留读取兼容，重新设置密码后自动升级为本格式。
 */
export const hashAlbumPassword = (plain: string): string => {
  const salt = randomBytes(16).toString('hex')
  const cost = 16384
  const blockSize = 8
  const parallelization = 1
  const digest = scryptSync(plain, salt, 32, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024,
  }).toString('hex')
  return `${SCRYPT_V1_PREFIX}${cost}$${blockSize}$${parallelization}$${salt}$${digest}`
}

/**
 * 校验相簿密码：
 * - `sha256$<盐>$<hash>`：以存储的盐重算 sha256(盐+明文) 后恒定时间比对
 * - `sha256$<hash>`      兼容上一版「无盐 sha256」
 * - `scrypt$…`           兼容更早期 scrypt 历史密码
 * - 其他格式一律视为无效
 */
export const verifyAlbumPassword = async (
  stored: string,
  plain: string,
): Promise<boolean> => {
  if (stored.startsWith(SCRYPT_V1_PREFIX)) {
    const [costRaw, blockRaw, parallelRaw, salt, digest] = stored
      .slice(SCRYPT_V1_PREFIX.length)
      .split('$')
    const cost = Number(costRaw)
    const blockSize = Number(blockRaw)
    const parallelization = Number(parallelRaw)
    if (
      !Number.isInteger(cost) ||
      !Number.isInteger(blockSize) ||
      !Number.isInteger(parallelization) ||
      !salt ||
      !digest
    ) {
      return false
    }
    try {
      const expected = scryptSync(plain, salt, 32, {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: 64 * 1024 * 1024,
      }).toString('hex')
      return safeEquals(digest.toLowerCase(), expected.toLowerCase())
    } catch {
      return false
    }
  }
  if (stored.startsWith(SHA_PREFIX)) {
    const parts = stored.slice(SHA_PREFIX.length).split('$')
    // 带盐格式：['盐', 'hash']
    if (parts.length === 2 && parts[0] && parts[1]) {
      const expected = sha256Hex(`${parts[0].toLowerCase()}${plain}`)
      return safeEquals(parts[1].toLowerCase(), expected.toLowerCase())
    }
    // 无盐旧格式：单段 64 位 hex
    if (parts.length === 1 && parts[0]) {
      return safeEquals(
        parts[0].toLowerCase(),
        sha256Hex(plain).toLowerCase(),
      )
    }
    return false
  }
  if (stored.startsWith(SCRYPT_PREFIX)) {
    // verifyPassword 来自 nuxt-auth-utils（全局自动导入）
    return await verifyPassword(stored, plain)
  }
  return false
}
