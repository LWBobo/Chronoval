import { getScanAlbumMetaBySlug } from '~~/server/services/scan-library/album-meta'
import { and, eq, tables } from '~~/server/utils/db'
import { ensureAlbumUid } from '~~/server/utils/albumUid'
import { getManualAlbumById } from '~~/server/services/collections/manual-album'
import { albumOpenToActor } from '~~/server/utils/albumVisibility'
import {
  getScanAlbumEffectiveVisibility,
  getScanLibraryByKey,
} from '~~/server/services/scan-library/manager'

/**
 * 通过自定义URL别名解析相簿，返回其归属类型与可访问标识。
 * - 普通相簿（albums.slug）：返回 kind='manual' + uid，前台跳转到规范地址。
 * - 外部库相簿（folder collection）：返回 kind='scan' + libId/mount/relPath，
 *   供前台 /albums/s/{slug} 页面直接渲染扫描相簿。
 */
export default eventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: 'Slug is required' })
  }

  const db = useDB()
  const actor = await getActor(event)

  // 优先匹配普通相簿的 uid，其次扫描相簿元数据

  const manual = db
    .select()
    .from(tables.collections)
    .where(
      and(
        eq(tables.collections.kind, 'manual'),
        eq(tables.collections.slug, slug),
      ),
    )
    .get()
  if (manual) {
    const album = getManualAlbumById(manual.id)
    if (!album || !albumOpenToActor(album, actor)) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
    const uid = await ensureAlbumUid(db, manual)
    return { kind: 'manual', uid }
  }

  const meta = await getScanAlbumMetaBySlug(slug)
  if (!meta) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const libId = Number(meta.mount.replace(/^scan_/, ''))
  if (!Number.isFinite(libId)) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const library = getScanLibraryByKey(String(libId))
  if (!library?.enabled || library.displayMode === 'gallery') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const visibility = getScanAlbumEffectiveVisibility(libId, meta.relPath)
  if (!albumOpenToActor({ visibility }, actor)) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  return {
    kind: 'scan',
    libId,
    mount: meta.mount,
    relPath: meta.relPath,
  }
})
