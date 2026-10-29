import { and, asc, eq, getTableColumns, isNull } from 'drizzle-orm'
import z from 'zod'
import { hasAlbumAccess } from '~~/server/utils/manualAlbumAuth'
import {
  isPasswordExemptForUser,
  parseExemptUsers,
} from '~~/server/utils/albumPasswordExempt'
import {
  isAlbumAdminBypass,
  redactAlbumSecrets,
} from '~~/server/utils/albumAccess'
import { ensureAlbumUid } from '~~/server/utils/albumUid'
import { getDisabledScanMountSet } from '~~/server/services/scan-library/manager'
import { blockedPhotoIdsForActor } from '~~/server/services/ml/person.service'
import { albumOpenToActor } from '~~/server/utils/albumVisibility'
import { getManualAlbumByPublicKey } from '~~/server/services/collections/manual-album'
import { resolveRandomQuotesPool } from '~~/server/services/settings/quoteLibraries'
import { discoverablePhotoIds } from '~~/server/utils/photo-access'

export default eventHandler(async (event) => {
  const { listMusic, serializeMusic } = await import('~~/server/services/music')

  // 预载音乐盒 BGM，供相簿背景音乐回显
  const musicMap = new Map<number, ReturnType<typeof serializeMusic>>()
  for (const m of await listMusic()) {
    musicMap.set(m.id, serializeMusic(m))
  }
  const resolveBgm = (bgmMusicId?: number | null) =>
    (bgmMusicId && musicMap.get(bgmMusicId)) || null
  // 支持两种公开访问标识：数字 id（兼容存量链接）与不透明 uid
  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({
      albumId: z.string().min(1),
    }).parse,
  )

  const query = await getValidatedQuery(
    event,
    z.object({
      // 管理端编辑面板专用：管理员传 manage=1 时始终返回完整照片（用于编辑，不对外暴露）
      manage: z.string().optional(),
    }).parse,
  )

  const db = useDB()
  const album = getManualAlbumByPublicKey(albumId)

  if (!album) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Album not found',
    })
  }

  // 整套相簿公开逻辑以整数 id 为内部主键，统一定位内部 id
  const albumPk = album.id

  // 可见级别与相簿密码是两个独立条件：login/admin 不得由输入相簿密码替代。
  const actor = await getActor(event)
  if (
    !(query.manage === '1' && actor.isAdmin) &&
    !albumOpenToActor(album, actor)
  ) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Album not found',
    })
  }

  // 密码访问权判定（与扫描相簿一致）：只有显式打开「管理员免密」开关才放行管理员，
  // 否则管理员也必须输入密码；公开访问必须持有解锁 Cookie。
  // 管理端编辑场景（manage=1 + 管理员）例外：管理相簿照片需要返回完整数据。
  const isAdmin = actor.isAdmin
  const manageMode = query.manage === '1' && isAdmin
  const adminBypass = await isAlbumAdminBypass(event, actor)
  // 密码免密范围：登录用户在相簿配置的免密范围内（所有登录用户/指定用户）则免密
  const passwordExempt = isPasswordExemptForUser(album, actor.user)
  const authorized =
    manageMode ||
    passwordExempt ||
    hasAlbumAccess(
      event,
      {
        albumId: albumPk,
        passwordHash: album.passwordHash,
        sessionExempt: passwordExempt,
      },
      Boolean(adminBypass),
    )

  const passwordProtected = Boolean(album.passwordHash)

  // 惰性补全并返回公开 UID
  const uid = await ensureAlbumUid(db, album)

  // 公共字段（不暴露哈希、明文，也不暴露免密用户邮箱列表）
  const revealed = redactAlbumSecrets(album, manageMode)
  const safeAlbum = manageMode
    ? {
        ...revealed,
        uid,
        passwordExemptMode: album.passwordExemptMode ?? undefined,
        passwordExemptUsers: parseExemptUsers(album.passwordExemptUsers),
      }
    : { ...revealed, uid }

  // 「随机照片轮经典语录」最终生效语录池：标签优先（内置古诗/现代库），否则自定义，两者皆无则空（旋转时不显示）
  const randomQuotesPool = await resolveRandomQuotesPool(
    (album as any).randomQuotesTag,
    (album as any).randomQuotes,
  )

  // 未解锁的受保护相簿：仅返回标题/介绍/封面等元数据用于加锁界面，不返回照片
  if (passwordProtected && !authorized) {
    return {
      ...safeAlbum,
      coverPhotoId: null,
      bgmMusicId: null,
      randomQuotesPool,
      bgm: null,
      passwordProtected: true,
      authorized: false,
      photos: [],
    }
  }

  // 获取相册中的照片（排除已移入回收站的软删除照片）
  const photos = await db
    // all fields from tables.photos
    .select({
      ...getTableColumns(tables.photos),
    })
    .from(tables.photos)
    .innerJoin(
      tables.collectionPhotos,
      eq(tables.photos.id, tables.collectionPhotos.photoId),
    )
    .where(
      and(
        eq(tables.collectionPhotos.collectionId, albumPk),
        isNull(tables.photos.deletedAt),
      ),
    )
    .orderBy(asc(tables.collectionPhotos.position))
    .all()

  // 公开/编辑之外的普通访问：剔除「已禁用扫描库」的照片。
  // 禁用库的图片路由（/library/<mount>/...）已不再提供，留在相册里会导致点击后加载失败；
  // 管理员编辑模式（manage=1）需保留完整照片以便管理（与后台 /dashboard 一致）。
  if (!manageMode) {
    const disabledScanMounts = getDisabledScanMountSet()
    if (disabledScanMounts.size > 0) {
      const filtered = photos.filter(
        (p) => !p.libraryMount || !disabledScanMounts.has(p.libraryMount),
      )
      // 复用兜底去重前的数组引用；下方 uniquePhotos 基于该数组去重
      photos.length = 0
      photos.push(...filtered)
    }
  }

  // 验证相册数据完整性
  if (!photos || !Array.isArray(photos)) {
    // 空相册也是合法的，只需要返回空数组
    return {
      ...safeAlbum,
      randomQuotesPool,
      bgm: resolveBgm((album as any).bgmMusicId),
      passwordProtected,
      authorized,
      photos: [],
    }
  }

  // 兜底去重：防御历史脏数据导致的重复行（正常由唯一索引保证唯一）
  const seen = new Set<string>()
  const blockedByPerson = manageMode
    ? new Set<string>()
    : blockedPhotoIdsForActor(actor)
  let uniquePhotos = photos.filter((p) => {
    if (seen.has(p.id) || blockedByPerson.has(p.id)) return false
    seen.add(p.id)
    return true
  })

  if (!manageMode && uniquePhotos.length > 0) {
    const visibleIds = await discoverablePhotoIds(
      event,
      uniquePhotos.map((photo) => photo.id),
    )
    uniquePhotos = uniquePhotos.filter((photo) => visibleIds.has(photo.id))
  }

  return {
    ...safeAlbum,
    randomQuotesPool,
    bgm: resolveBgm((album as any).bgmMusicId),
    passwordProtected,
    authorized,
    coverPhotoId: uniquePhotos.some((photo) => photo.id === album.coverPhotoId)
      ? album.coverPhotoId
      : (uniquePhotos.find((photo) => photo.type !== 'video')?.id ?? null),
    photos: manageMode
      ? uniquePhotos
      : uniquePhotos.map((photo) => toPublicPhoto(photo)),
  }
})
