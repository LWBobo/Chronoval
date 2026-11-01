import { photoWithMediaColumns } from '../../utils/photo-media'
import { and, asc, desc, isNull, notInArray, or } from 'drizzle-orm'
import { getGalleryHiddenScanMountSet } from '~~/server/services/scan-library/manager'
import { homepageGalleryVisibilitySql } from '~~/server/utils/gallery-visibility'
import { viewerFromActor } from '~~/server/services/ml/person.service'
import { appliedTagNamesForPhotos } from '~~/server/services/ml/tags.service'

export default eventHandler(async (event) => {
  // 确定性排序：先按拍摄时间倒序，再按 id 升序兜底。
  // 同一拍摄时间出现平手时，数据库返回顺序不保证稳定，会导致
  // 两次拉取/返回画廊时照片顺序抖动。显式按 id 排序后首次进入与返回完全一致。
  // 同时过滤掉已移入回收站（软删除）的照片。
  //
  // 分页支持（limit/offset）：首页画廊在照片达到数万张时改为"首批快速出图 +
  // 客户端后台分片补齐"，避免一次性返回数十 MB 的大 JSON。不传 limit 时保持
  // 全量返回，后台管理等旧调用方完全兼容。
  const q = getQuery(event)
  const galleryOnly = q.gallery === '1'
  const actor = await getActor(event)
  const isAdmin = actor.isAdmin && q.manage === '1'
  if(q.manage==='1'&&!actor.isAdmin)throw createError({statusCode:403,message:'Admin privileges required'})
  const loggedIn = Boolean(actor.user)

  const limitRaw = parseInt(String(q.limit ?? ''), 10)
  const offsetRaw = parseInt(String(q.offset ?? ''), 10)
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 0
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0

  const where = [isNull(tables.photos.deletedAt)]

  // 首页画廊（?gallery=1，以及非管理员）：隐藏纯相簿展示（displayMode=album）
  // 和已禁用的扫描库。登录可见的相簿在登录后进入瀑布流，密码相簿始终不进入。
  // 后台管理（管理员且非 gallery=1）保留全量。过滤必须进 SQL，避免分页缺行。
  if (!(isAdmin && !galleryOnly)) {
    where.push(
      homepageGalleryVisibilitySql(
        loggedIn,
        viewerFromActor(actor),
        actor.user?.id ?? null,
      ),
    )
    const hiddenScanMounts = getGalleryHiddenScanMountSet()
    if (hiddenScanMounts.size > 0) {
      // library_mount 可能为 NULL（上传照片）：NOT IN 会把 NULL 行排除掉，
      // 所以需要 or(isNull, notInArray) 组合
      where.push(
        or(
          isNull(tables.photos.libraryMount),
          notInArray(
            tables.photos.libraryMount,
            Array.from(hiddenScanMounts),
          ),
        )!,
      )
    }
  }

  let stmt = useDB()
    .select(photoWithMediaColumns())
    .from(tables.photos)
    .where(and(...where))
    .orderBy(desc(tables.photos.dateTaken), asc(tables.photos.id))
    .$dynamic()
  if (limit > 0) stmt = stmt.limit(limit)
  if (offset > 0) stmt = stmt.offset(offset)

  const rows = stmt.all()
  const mlTags = appliedTagNamesForPhotos(rows.map((row) => row.id))
  return rows.map((row) => ({
    ...(isAdmin ? row : toPublicPhoto(row)),
    mlTags: mlTags.get(row.id) || [],
  }))
})
