import { photoAssetSql } from '../../utils/photo-media'
import { eq, tables, useDB } from '~~/server/utils/db'
import { parseExemptUsers } from '~~/server/utils/albumPasswordExempt'
import { redactAlbumSecrets } from '~~/server/utils/albumAccess'
import { blockedPhotoIdsForActor } from '~~/server/services/ml/person.service'
import { listManualAlbums } from '~~/server/services/collections/manual-album'
import { albumOpenToActor } from '~~/server/utils/albumVisibility'
import { hasAlbumAccess } from '~~/server/utils/manualAlbumAuth'
import { isPasswordExemptForUser } from '~~/server/utils/albumPasswordExempt'
import { isAlbumAdminBypass } from '~~/server/utils/albumAccess'
import { discoverablePhotoIds } from '~~/server/utils/photo-access'
import { serializeScanAlbumNodes } from '~~/server/utils/scan-album-response'

export default eventHandler(async (event) => {
  const db = useDB()
  const { listScanAlbumRoots, getDisabledScanMountSet } =
    await import('~~/server/services/scan-library/manager')
  const { ensureAlbumUid } = await import('~~/server/utils/albumUid')
  const { serializeMusic, listMusic } = await import('~~/server/services/music')

  // 预载全部音乐盒 BGM，供相簿回显（避免循环内并发查询 better-sqlite3 预编译语句串扰）
  const musicMap = new Map<number, ReturnType<typeof serializeMusic>>()
  for (const m of await listMusic()) {
    musicMap.set(m.id, serializeMusic(m))
  }

  // 管理端（登录管理员）返回完整树状二级相簿并包含隐藏的外部库相簿；
  // 公开访问时过滤掉设置为“隐藏”的外部库相簿。
  const actor = await getActor(event)
  const requestedManage = getQuery(event).manage === '1'
  if (requestedManage && !actor.isAdmin) throw createError({statusCode:403,message:'Admin privileges required'})
  const isAdmin = requestedManage && actor.isAdmin
  const blockedByPerson = blockedPhotoIdsForActor(actor)
  const adminBypass = await isAlbumAdminBypass(event, actor)

  // 非管理员：剔除「已禁用扫描库」的照片，避免相册封面/列表出现加载失败的坏图
  const disabledScanMounts = getDisabledScanMountSet()

  // 获取所有相册，按创建时间倒序。仅管理员相簿不返回给普通账号，避免标题泄露。
  const albums = listManualAlbums().filter((album) =>
    albumOpenToActor(album, actor),
  )

  // 为每个相册获取照片 ID 列表与封面堆叠数据。
  // 注意：better-sqlite3 为同步驱动，必须串行（不能 Promise.all 并发）执行，
  // 否则同一连接上的 prepared 语句参数状态会互相错乱。
  const albumsWithPhotoIds: any[] = []
  for (const album of albums) {
    const passwordExempt = isPasswordExemptForUser(album, actor.user)
    const authorized =
      !album.passwordHash ||
      isAdmin ||
      passwordExempt ||
      hasAlbumAccess(
        event,
        {
          albumId: album.id,
          passwordHash: album.passwordHash,
          sessionExempt: passwordExempt,
        },
        Boolean(adminBypass),
      )

    // 一次查询取回相簿照片及对应缩略图封面信息（按相簿内位置排序）。
    // 关键：不能对每个封面照片单独发查询，better-sqlite3 的 prepared 语句
    // 在多次复用时会参数错乱；合并成单条查询可绕开该问题。
    const photoRows = db
      .select({
        photoId: tables.collectionPhotos.photoId,
        position: tables.collectionPhotos.position,
        thumbnailUrl: photoAssetSql('thumbnail'),
        thumbnailHash: tables.photos.thumbnailHash,
        aspectRatio: tables.photos.aspectRatio,
        libraryMount: tables.photos.libraryMount,
        type: tables.photos.type,
      })
      .from(tables.collectionPhotos)
      .leftJoin(
        tables.photos,
        eq(tables.collectionPhotos.photoId, tables.photos.id),
      )
      .where(eq(tables.collectionPhotos.collectionId, album.id))
      .orderBy(tables.collectionPhotos.position)
      .all()
    // 非管理员：剔除已禁用扫描库的照片，封面与 photoIds 均不再引用
    let rows = (
      !isAdmin && disabledScanMounts.size > 0
        ? photoRows.filter(
            (r) => !r.libraryMount || !disabledScanMounts.has(r.libraryMount),
          )
        : photoRows
    ).filter((row) => !blockedByPerson.has(row.photoId))

    if (!isAdmin && rows.length > 0) {
      const visibleIds = await discoverablePhotoIds(
        event,
        rows.map((row) => row.photoId),
      )
      rows = rows.filter((row) => visibleIds.has(row.photoId))
    }
    if (!authorized) rows = []

    const photoIds = rows.map((r) => r.photoId)

    const restAlbum = redactAlbumSecrets(album, false)

    // 免密配置仅对管理员回显（编辑面板需要）；公开访问不返回（含用户邮箱隐私）
    const exemptAdminOnly = isAdmin
      ? {
          passwordExemptMode: album.passwordExemptMode ?? undefined,
          passwordExemptUsers: parseExemptUsers(album.passwordExemptUsers),
        }
      : {}

    // 惰性补全公开 UID（存量相簿首次返回时自动落库）。
    // 同时保证公开链接使用不透明 uid，而非暴露自增 id。
    const uid = await ensureAlbumUid(db, album)

    // 构造相簿封面堆叠数据（与外部库相簿 covers 一致），
    // 让普通相簿也能在相簿首页展示「多张照片堆叠」效果。
    // 封面照片置顶，其余按相簿内顺序补充，最多 3 张。
    const covers: {
      id: string
      thumbnailUrl: string | null
      thumbnailHash: string | null
      aspectRatio: number | null
    }[] = []
    if (rows.length) {
      const ordered: string[] = []
      if (album.coverPhotoId) ordered.push(album.coverPhotoId)
      for (const pid of photoIds) {
        if (!ordered.includes(pid)) ordered.push(pid)
      }
      const rowById = new Map(rows.map((r) => [r.photoId, r]))
      for (const pid of ordered) {
        if (covers.length >= 3) break
        const row = rowById.get(pid)
        if (row?.thumbnailUrl && row.type !== 'video') {
          covers.push({
            id: row.photoId,
            thumbnailUrl: row.thumbnailUrl,
            thumbnailHash: row.thumbnailHash,
            aspectRatio: row.aspectRatio,
          })
        }
      }
    }

    albumsWithPhotoIds.push({
      ...restAlbum,
      coverPhotoId:
        authorized &&
        album.coverPhotoId &&
        photoIds.includes(album.coverPhotoId)
          ? album.coverPhotoId
          : (covers[0]?.id ?? null),
      uid,
      kind: 'manual',
      covers,
      // 密码类型：是否有访问密码（不暴露真实哈希）
      passwordProtected: Boolean(album.passwordHash),
      ...exemptAdminOnly,
      // 相簿背景音乐（音乐盒）：解析并返回 BGM 信息（null=未启用）
      bgm:
        authorized && album.bgmMusicId
          ? musicMap.get(album.bgmMusicId) || null
          : null,
      // 即使是空相册，也返回空数组而不是 undefined
      photoIds,
      photoCount: rows.filter((r) => r.type !== 'video').length,
      videoCount: rows.filter((r) => r.type === 'video').length,
    })
  }

  // 扫描库转为的相簿以根节点合并进相册列表（kind: 'scan'）。
  // 管理端需要树状二级相簿，故 includeChildren=isAdmin。
  // 扫描库是可选的「增强」特性：即便该模块初始化异常（如 migrate 未建表），
  // 也不应拖垮整个相簿列表接口导致「加载相簿失败」——此处隔离兜底。
  let visibleScanRoots: Awaited<ReturnType<typeof listScanAlbumRoots>> = []
  try {
    visibleScanRoots = await serializeScanAlbumNodes(
      event,
      await listScanAlbumRoots(isAdmin),
      {
        actor,
        manageMode: isAdmin,
        adminBypass,
        resolveBgm: (id) => (id ? musicMap.get(id) || null : null),
      },
    )
  } catch (error) {
    console.error('[albums] 扫描库相簿加载失败：', error)
  }

  const combined: unknown[] = [
    ...albumsWithPhotoIds.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
    ...visibleScanRoots,
  ]
  return combined
})
