import { asc, desc, isNull } from 'drizzle-orm'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'

export default eventHandler(async (event) => {
  // 确定性排序：先按拍摄时间倒序，再按 id 升序兜底。
  // 同一拍摄时间出现平手时，数据库返回顺序不保证稳定，会导致
  // 两次拉取/返回画廊时照片顺序抖动。显式按 id 排序后首次进入与返回完全一致。
  // 同时过滤掉已移入回收站（软删除）的照片。
  const rows = useDB()
    .select()
    .from(tables.photos)
    .where(isNull(tables.photos.deletedAt))
    .orderBy(desc(tables.photos.dateTaken), asc(tables.photos.id))
    .all()

  // 首页画廊：隐藏已禁用、以及未勾选「瀑布流」的扫描库。
  const galleryOnly = getQuery(event).gallery === '1'

  const session = await getUserSession(event).catch(() => null)
  const isAdmin = Boolean((session as any)?.user?.isAdmin)
  if (isAdmin && !galleryOnly) return rows

  const hiddenScanMounts = getGalleryHiddenScanMountSet()
  if (hiddenScanMounts.size === 0) return rows
  return rows.filter(
    (p) => !p.libraryMount || !hiddenScanMounts.has(p.libraryMount),
  )
})