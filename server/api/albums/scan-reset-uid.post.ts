import { z } from 'zod'
import { scanMountName } from '~~/server/services/scan-library/manager'
import {
  getScanAlbumMeta,
  upsertScanAlbumMeta,
} from '~~/server/services/scan-library/album-meta'
import { eq } from 'drizzle-orm'
import { useDB, tables } from '~~/server/utils/db'

/**
 * 手动重置外部库（扫描库）相簿的公开 URL 标识。
 * 为该文件夹集合生成新的随机 urlKey，使旧公开地址立即失效。
 * 仅管理员可访问。
 */
export default eventHandler(async (event) => {

  const body = await readValidatedBody(
    event,
    z.object({
      libId: z.number().int().positive(),
      path: z.string().default(''),
    }).parse,
  )

  const mount = scanMountName(body.libId)
  const db = useDB()

  const existing = await getScanAlbumMeta(mount, body.path)
  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Album meta not found' })
  }

  // 在唯一索引兜底下生成一个不冲突的新 urlKey（8 位字母数字）
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let urlKey: string | null = null
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = Array.from(
      { length: 8 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join('')
    const duplicate = db
      .select({ id: tables.collections.id })
      .from(tables.collections)
      .where(eq(tables.collections.urlKey, candidate))
      .get()
    if (!duplicate) {
      urlKey = candidate
      break
    }
  }
  if (!urlKey) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Unable to generate a unique album URL key',
    })
  }

  const meta = await upsertScanAlbumMeta({
    mount,
    relPath: body.path,
    urlKey,
  })

  return { success: true, urlKey: meta.urlKey }
})
