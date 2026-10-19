import {
  and,
  asc,
  desc,
  isNull,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'
import { homepageGalleryVisibilitySql } from '~~/server/utils/gallery-visibility'
import { viewerFromActor } from '~~/server/services/ml/person.service'
import { appliedTagNamesForPhotos } from '~~/server/services/ml/tags.service'

export default eventHandler(async (event) => {
  const db = useDB()

  // 分页支持（limit/offset）：首页画廊数万张时客户端分片渐进加载；不传则全量返回（兼容）
  const q = getQuery(event)
  const limitRaw = parseInt(String(q.limit ?? ''), 10)
  const offsetRaw = parseInt(String(q.offset ?? ''), 10)
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 0
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0

  const actor = await getActor(event)
  const where: SQL[] = []

  // 排除软删除。登录可见的相簿仅对已登录用户出现；密码相簿不进瀑布流。
  where.push(isNull(tables.photos.deletedAt))
  where.push(homepageGalleryVisibilitySql(Boolean(actor.user), viewerFromActor(actor)))

  // 排除纯相簿展示（displayMode=album）或已禁用的扫描库照片。
  // 共存模式（both）仍留在首页画廊。过滤必须进 SQL，避免分页事后过滤缺行。
  const hiddenScanMounts = getGalleryHiddenScanMountSet()
  if (hiddenScanMounts.size > 0) {
    // library_mount 可能为 NULL（上传照片）：NOT IN 会把 NULL 行排除掉，
    // 所以需要 or(isNull, notInArray) 组合
    where.push(
      or(
        isNull(tables.photos.libraryMount),
        notInArray(tables.photos.libraryMount, Array.from(hiddenScanMounts)),
      )!,
    )
  }

  let stmt = db
    .select()
    .from(tables.photos)
    .where(and(...where))
    .orderBy(desc(tables.photos.dateTaken), asc(tables.photos.id))
    .$dynamic()
  if (limit > 0) stmt = stmt.limit(limit)
  if (offset > 0) stmt = stmt.offset(offset)

  const rows = stmt.all()
  const mlTags = appliedTagNamesForPhotos(rows.map((row) => row.id))
  return rows.map((row) => ({
    ...row,
    mlTags: mlTags.get(row.id) || [],
  }))
})
