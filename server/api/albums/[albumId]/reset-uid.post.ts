import { z } from 'zod'
import { and } from 'drizzle-orm'
import { generateAvailableAlbumUid } from '~~/server/utils/albumUid'

/**
 * 手动重置相簿公开 UID（仅普通相簿）。
 * 当公开链接可能已泄露/被枚举时需要换新：生成一个新的不透明 UID 并落库，
 * 旧的公开链接随即失效。UID 只在管理员显式触发时才会改变，绝不自动变化。
 */
export default eventHandler(async (event) => {

  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({
      albumId: z
        .string()
        .regex(/^\d+$/)
        .transform((val) => parseInt(val, 10)),
    }).parse,
  )

  const db = useDB()

  const album = await db
    .select()
    .from(tables.collections)
    .where(
      and(
        eq(tables.collections.id, albumId),
        eq(tables.collections.kind, 'manual'),
      ),
    )
    .get()

  if (!album) {
    throw createError({ statusCode: 404, statusMessage: 'Album not found' })
  }

  const uid = generateAvailableAlbumUid(db)

  const updatedAlbum = db.transaction((tx) =>
    tx
      .update(tables.collections)
      .set({ uid, updatedAt: new Date() })
      .where(
        and(
          eq(tables.collections.id, albumId),
          eq(tables.collections.kind, 'manual'),
        ),
      )
      .returning()
      .get(),
  )

  if (!updatedAlbum) {
    throw createError({ statusCode: 404, statusMessage: 'Album not found' })
  }

  const { passwordHash: _ph, ...safeAlbum } = updatedAlbum
  return { ...safeAlbum, uid }
})
