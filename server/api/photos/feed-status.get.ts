import { and, count, isNull, max, notInArray, or, type SQL } from 'drizzle-orm'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'
import { homepageGalleryVisibilitySql } from '~~/server/utils/gallery-visibility'
import { viewerFromActor } from '~~/server/services/ml/person.service'

/**
 * 画廊"指纹"接口（轻量）：只返回当前画廊可见照片的 数量 + 最新拍摄时间，
 * 不含 EXIF/完整 JSON，用于前端只有在集合发生变化时才触发一次完整 refresh。
 *
 * 可见性与首页画廊一致，并跟随当前登录状态：
 * 登录可见的相簿在登录后计入，密码相簿不计，纯相簿展示或已禁用的扫描库不计。
 */
export default eventHandler(async (event) => {
  const db = useDB()
  const actor = await getActor(event)

  const where: SQL[] = [
    isNull(tables.photos.deletedAt),
    homepageGalleryVisibilitySql(
      Boolean(actor.user),
      viewerFromActor(actor),
      actor.user?.id ?? null,
    ),
  ]

  const hiddenScanMounts = [...getGalleryHiddenScanMountSet()]
  if (hiddenScanMounts.length > 0) {
    where.push(
      or(
        isNull(tables.photos.libraryMount),
        notInArray(tables.photos.libraryMount, hiddenScanMounts),
      )!,
    )
  }

  // 聚合留在 SQLite 内完成。旧实现每 8 秒把全部可见照片 id/挂载/时间读进 Node
  // 再循环统计，访客数量和照片数量增加时会造成不必要的对象分配与传输。
  const row = db
    .select({
      count: count(),
      maxDateTaken: max(tables.photos.dateTaken),
    })
    .from(tables.photos)
    .where(and(...where))
    .get()

  return {
    count: Number(row?.count || 0),
    maxDateTaken: row?.maxDateTaken || null,
    t: Date.now(),
  }
})
