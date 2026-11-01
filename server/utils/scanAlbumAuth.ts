import { collectionPasswordAccess, authorizeCollection } from './collection-password'
import { and, eq } from 'drizzle-orm'
import { createHash, createHmac } from 'node:crypto'
import { normalizeAlbumPath } from './album-path'
import { safeTokenEqual } from './token'

/**
 * 扫描相簿（外部库转相簿）的访问密码鉴权。
 *
 * 密码存于文件夹集合（collections.password_hash，
 * 由后台相册的相簿编辑面板维护）。解锁令牌按 相簿 id + 相对路径 签发，
 * 因此不同子相簿可以各自带密码，互不干扰；密码变更后旧令牌自动失效。
 * - 管理员是否免密由调用方传入（系统开关 scanAlbum.adminBypass），默认不因管理员身份放行。
 * - 无密码时视为开放相簿（直接放行）。
 */

/** 解锁 Cookie 名：同一相簿可按不同相对路径分别解锁 */
export const scanAlbumCookieName = (libId: number, relPath: string): string => {
  const normalized = normalizeAlbumPath(relPath)
  if (!normalized) return `scan_album_${libId}`
  const pathHash = createHash('sha256').update(normalized).digest('hex')
  return `scan_album_${libId}_${pathHash}`
}

const getSecret = (): string => {
  const secret =
    process.env.SCAN_ALBUM_UNLOCK_SECRET || process.env.NUXT_SESSION_PASSWORD
  if (!secret) throw new Error('Scan album unlock secret is not configured')
  return secret
}

/** 生成与当前密码哈希绑定的解锁令牌 */
export const scanAlbumToken = (
  scopeKey: string,
  passwordHash: string | null,
): string => {
  return createHmac('sha256', getSecret())
    .update(`${scopeKey}:${passwordHash || ''}`)
    .digest('base64url')
}

/**
 * 是否已获得相簿访问权限。
 * @param allowAdmin 是否放行管理员（仅当系统开关 scanAlbum.adminBypass 打开时为真）
 * @param passwordHash 该相簿生效的密码哈希；null 表示未设置密码（开放）
 * @param sessionExempt 当前登录用户是否在相簿配置的免密范围内（由调用方依据会话判定）
 */
export const hasScanAlbumAccess = (
  event: any,
  opts: {
    libId: number
    relPath: string
    passwordHash: string | null
    sessionExempt?: boolean
  },
  allowAdmin: boolean,
): boolean => {
  const id = folderId(opts.libId, opts.relPath)
  return !!id && collectionPasswordAccess(event, id, allowAdmin)
}

/** 签发解锁 Cookie（密码校验通过后调用） */
export const authorizeScanAlbum = (
  event: any,
  opts: { libId: number; relPath: string; passwordHash: string | null },
): Promise<void> => {
  const id = folderId(opts.libId, opts.relPath)
  if (!id) throw createError({ statusCode: 404, message: 'Collection not found' })
  return authorizeCollection(event, id)
}

/** 清除解锁 Cookie */
export const revokeScanAlbum = (
  event: any,
  libId: number,
  relPath?: string,
): void => {
  deleteCookie(event, scanAlbumCookieName(libId, relPath || ''), { path: '/' })
}

/** 祖先令牌只能用于当前生效的密码，子目录单独设置密码后构成新的边界。 */
export function hasInheritedScanAlbumAccess(
  event: any,
  opts: {
    libId: number
    relPath: string
    passwordHash: string | null
    passwordPath: string | null
    sessionExempt?: boolean
  },
  allowAdmin: boolean,
): boolean {
  const id = folderId(opts.libId, opts.relPath)
  return !!id && collectionPasswordAccess(event, id, allowAdmin)
}

function folderId(libId: number, relPath: string) {
  return useDB().select({ id: tables.collections.id }).from(tables.collections).where(and(eq(tables.collections.kind,'folder'),eq(tables.collections.libraryId,libId),eq(tables.collections.relPath,normalizeAlbumPath(relPath)))).get()?.id
}
