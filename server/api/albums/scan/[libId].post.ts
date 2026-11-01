import { folderAudienceAccess } from '~~/server/services/collections/access'
import { z } from 'zod'
import {
  getScanLibraryByKey,
  getScanAlbumEffectiveAuth,
  getScanAlbumDetail,
  getScanAlbumEffectiveVisibility,
} from '~~/server/services/scan-library/manager'
import { getScanAlbumMetaByUrlKey } from '~~/server/services/scan-library/album-meta'
import {
  authorizeScanAlbum,
} from '~~/server/utils/scanAlbumAuth'
import { isPasswordExemptForUser } from '~~/server/utils/albumPasswordExempt'
import { verifyAlbumPassword } from '~~/server/utils/scanAlbumPassword'
import { isAlbumAdminBypass } from '~~/server/utils/albumAccess'
import { albumOpenToActor } from '~~/server/utils/albumVisibility'

export default eventHandler(async (event) => {
  const { libId } = await getValidatedRouterParams(
    event,
    z.object({ libId: z.string() }).parse,
  )
  const query = await getValidatedQuery(
    event,
    z.object({ path: z.string().optional().default('') }).parse,
  )
  const body = await readValidatedBody(
    event,
    z.object({ password: z.string() }).parse,
  )

  assertRateLimit(event, {
    namespace: 'scan-album-unlock',
    subject: `${libId}:${query.path}`,
    limit: 15,
    windowMs: 10 * 60 * 1000,
  })

  // 与 GET 一致：先按相簿自身 urlKey 定位，命中则用其 mount/relPath
  const byMetaUrl = await getScanAlbumMetaByUrlKey(libId)
  let libIdNum: number
  let relPath: string
  if (byMetaUrl) {
    const parsed = Number(byMetaUrl.mount.replace(/^scan_/, ''))
    if (!Number.isFinite(parsed)) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
    const lib = getScanLibraryByKey(String(parsed))
    if (!lib || lib.displayMode === 'gallery' || !lib.enabled) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
    libIdNum = lib.id
    relPath = query.path
      ? [byMetaUrl.relPath || '', query.path].filter(Boolean).join('/')
      : byMetaUrl.relPath || ''
  } else {
    const lib = getScanLibraryByKey(libId)
    if (!lib || lib.displayMode === 'gallery' || !lib.enabled) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
    libIdNum = lib.id
    relPath = query.path
  }

  const effAuth = await getScanAlbumEffectiveAuth(libIdNum, relPath)
  const passwordHash = effAuth.passwordHash

  // 管理员的「免密访问」只有在显式开启对应系统设置时才放行；
  // 默认关闭：即使登录管理员，也必须输入正确相簿密码。
  const actor = await getActor(event)
  const detail = await getScanAlbumDetail(libIdNum, relPath)
  const visibility = getScanAlbumEffectiveVisibility(libIdNum, relPath)
  if (!detail || !folderAudienceAccess(libIdNum, relPath, actor)) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const adminBypass = await isAlbumAdminBypass(event, actor)

  if (adminBypass) {
    await authorizeScanAlbum(event, {
      libId: libIdNum,
      relPath,
      passwordHash,
    })
    return { authorized: true }
  }

  // 登录用户在相簿配置的免密范围内（所有登录用户/指定用户）：无需密码直接签发解锁 Cookie
  if (
    isPasswordExemptForUser(
      {
        passwordHash,
        passwordExemptMode: effAuth.exemptMode,
        passwordExemptUsers: effAuth.exemptUsers,
      },
      actor.user,
    )
  ) {
    await authorizeScanAlbum(event, { libId: libIdNum, relPath, passwordHash })
    return { authorized: true }
  }

  if (!passwordHash || !(await verifyAlbumPassword(passwordHash, body.password))) {
    throw createError({ statusCode: 401, statusMessage: 'Incorrect password' })
  }

  await authorizeScanAlbum(event, { libId: libIdNum, relPath, passwordHash })
  return { authorized: true }
})
