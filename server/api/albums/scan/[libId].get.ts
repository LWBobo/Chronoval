import { folderAudienceAccess } from '~~/server/services/collections/access'
import { serializeScanAlbumNodes } from '~~/server/utils/scan-album-response'
import { z } from 'zod'
import {
  getScanLibraryByKey,
  getScanAlbumDetail,
  getScanAlbumEffectiveAuth,
  getScanAlbumEffectiveVisibility,
} from '~~/server/services/scan-library/manager'
import { getScanAlbumMetaByUrlKey } from '~~/server/services/scan-library/album-meta'
import { hasInheritedScanAlbumAccess } from '~~/server/utils/scanAlbumAuth'
import { isPasswordExemptForUser } from '~~/server/utils/albumPasswordExempt'
import { isAlbumAdminBypass } from '~~/server/utils/albumAccess'
import { resolveRandomQuotesPool } from '~~/server/services/settings/quoteLibraries'
import { discoverablePhotoIds } from '~~/server/utils/photo-access'
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

  // 预载音乐盒 BGM，用于相簿节点回显
  const { serializeMusic, listMusic } = await import('~~/server/services/music')
  const musicMap = new Map<number, ReturnType<typeof serializeMusic>>()
  for (const m of await listMusic()) {
    musicMap.set(m.id, serializeMusic(m))
  }
  const resolveBgm = (bgmMusicId?: number | null) =>
    (bgmMusicId && musicMap.get(bgmMusicId)) || null

  // 解析目标相簿对（libIdNum, relPath）：
  // 1) 先尝试按相簿自身 urlKey 定位 —— 命中则返回该相簿（mount+relPath），忽略 path 参数；
  // 2) 否则按扫描库级 urlKey / 数字 id 定位，配合 path 定位到具体目录相簿。
  const byMetaUrl = await getScanAlbumMetaByUrlKey(libId)
  let libIdNum: number
  let relPath: string
  let childInParent = true
  let childPosition: 'start' | 'end' = 'start'
  const readChildDisplay = (lib: {
    childInParent?: boolean | null
    childPosition?: string | null
  }) => {
    childInParent = lib.childInParent !== false
    childPosition = lib.childPosition === 'end' ? 'end' : 'start'
  }
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
    readChildDisplay(lib)
    // urlKey 标识的相簿可能是某目录层，公开链接 /albums/scan/{urlKey}/{子路径...} 可继续向下钻取；
    // 因此在基础 relPath 之上叠加 query.path，否则点击其子相簿会被错误地解析回父相簿（表现为“打不开”）。
    relPath = query.path
      ? [byMetaUrl.relPath || '', query.path].filter(Boolean).join('/')
      : byMetaUrl.relPath || ''
  } else {
    const lib = getScanLibraryByKey(libId)
    if (!lib || lib.displayMode === 'gallery' || !lib.enabled) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
    libIdNum = lib.id
    readChildDisplay(lib)
    relPath = query.path
  }

  const detail = await getScanAlbumDetail(libIdNum, relPath)
  if (!detail) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  // 相簿级生效密码：自身 meta 优先，未设置则向上继承/回退到扫描库旧密码；
  // 免密范围取生效密码同级 meta 的配置
  const effAuth = await getScanAlbumEffectiveAuth(libIdNum, relPath)
  const passwordHash = effAuth.passwordHash
  // 访问权只认「解锁 cookie」「免密范围」或显式开启的「管理员免密」开关；
  // 默认不因管理员身份放行，避免「任意密码都可进入」。
  const actor = await getActor(event)
  const visibility = getScanAlbumEffectiveVisibility(libIdNum, relPath)
  if (!folderAudienceAccess(libIdNum, relPath, actor)) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const adminBypass = await isAlbumAdminBypass(event, actor)
  // 登录用户在相簿配置的免密范围内（所有登录用户/指定用户）则免密
  const passwordExempt = isPasswordExemptForUser(
    {
      passwordHash,
      passwordExemptMode: effAuth.exemptMode,
      passwordExemptUsers: effAuth.exemptUsers,
    },
    actor.user,
  )
  const authorized =
    !passwordHash ||
    Boolean(adminBypass) ||
    passwordExempt ||
    hasInheritedScanAlbumAccess(
      event,
      {
        libId: libIdNum,
        relPath,
        passwordHash,
        passwordPath: effAuth.passwordPath,
      },
      false,
    )

  // 直接访问子目录时，节点自身可能没有密码，但父目录密码仍会向下生效。
  // 锁定判断必须使用 effective auth，不能只看当前节点元数据。
  const passwordProtected = Boolean(passwordHash)

  // 「随机照片轮经典语录」最终生效语录池：标签优先（内置古诗/现代库），否则自定义，两者皆无则空（旋转时不显示）
  const withRandomQuotePool = async (node: any): Promise<any> => {
    const pool = await resolveRandomQuotesPool(
      node.randomQuotesTag,
      node.randomQuotes,
    )
    const { password: _pw, children, ...rest } = stripPassword(node)
    const withBgm = { ...rest, bgm: resolveBgm(rest.bgmMusicId) }
    return children?.length
      ? {
          ...withBgm,
          children: await Promise.all(children.map(withRandomQuotePool)),
          randomQuotesPool: pool,
        }
      : { ...withBgm, randomQuotesPool: pool }
  }

  // 无论解锁与否，公开返回的节点都不带明文密码与免密用户列表（明文仅供管理端编辑面板回显）
  const stripPassword = (node: any): any => {
    const {
      password: _pw,
      passwordExemptMode: _pem,
      passwordExemptUsers: _peu,
      children,
      ...rest
    } = node
    return children?.length
      ? { ...rest, children: children.map(stripPassword) }
      : rest
  }

  // 未解锁的受保护相簿仅返回节点信息用于标题/封面展示，不返回目录照片与子相簿
  if (passwordProtected && !authorized) {
    const lockedNode = await withRandomQuotePool(detail.node)
    return {
      node: {
        ...lockedNode,
        visibility,
        coverPhotoId: null,
        covers: [],
        photoCount: 0,
        videoCount: 0,
        bgmMusicId: null,
        bgm: null,
        children: [],
        hasChildren: false,
      },
      dirPhotos: [],
      children: [],
      childInParent,
      childPosition,
      passwordProtected: true,
      authorized: false,
    }
  }

  const visiblePhotoIds = await discoverablePhotoIds(
    event,
    detail.dirPhotos.map((photo) => photo.id),
  )
  const safeNodes = await serializeScanAlbumNodes(
    event,
    [{ ...detail.node, children: detail.children }],
    { actor, adminBypass, resolveBgm },
  )
  const safeNode = safeNodes[0]
  if (!safeNode)
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  const { children: safeChildren = [], ...safeRoot } = safeNode
  const node = await withRandomQuotePool(safeRoot)
  const children = await Promise.all(safeChildren.map(withRandomQuotePool))

  return {
    ...detail,
    dirPhotos: detail.dirPhotos
      .filter((photo) => visiblePhotoIds.has(photo.id))
      .map((photo) => (actor.isAdmin ? photo : toPublicPhoto(photo))),
    node: { ...node, visibility },
    children,
    childInParent,
    childPosition,
    passwordProtected,
    authorized,
  }
})
