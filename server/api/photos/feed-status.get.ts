import { and, isNull } from 'drizzle-orm'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'
import { homepageGalleryVisibilitySql } from '~~/server/utils/gallery-visibility'

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

  const hiddenScanMounts = getGalleryHiddenScanMountSet()

  // 只取 id / 挂载 / 拍摄时间，不加载大字段；排除已移入回收站的软删除照片
  const rows = db
    .select({
      id: tables.photos.id,
      libraryMount: tables.photos.libraryMount,
      dateTaken: tables.photos.dateTaken,
    })
    .from(tables.photos)
    .where(
      and(
        isNull(tables.photos.deletedAt),
        homepageGalleryVisibilitySql(Boolean(actor.user)),
      ),
    )
    .all()

  let count = 0
  let maxDateTaken: string | null = null
  for (const r of rows) {
    if (r.libraryMount && hiddenScanMounts.has(r.libraryMount)) continue
    count++
    if (r.dateTaken && (!maxDateTaken || r.dateTaken > maxDateTaken)) {
      maxDateTaken = r.dateTaken
    }
  }

  return { count, maxDateTaken, t: Date.now() }
})