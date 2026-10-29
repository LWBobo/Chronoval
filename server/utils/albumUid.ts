import { randomBytes } from 'node:crypto'
import { eq, tables, useDB, type Album } from '~~/server/utils/db'

type DB = ReturnType<typeof useDB>
const UID_GENERATION_ATTEMPTS = 20

/**
 * 生成普通相簿的不透明公开 UID。
 * 使用随机字节转 base36（约 9 位字符），不再暴露自增 id，避免公网链接被枚举。
 * 确保结果不是纯数字，以便公开访问路由能清晰区分「UID」与「数字 id」。
 */
export function generateAlbumUid(): string {
  let uid = ''
  do {
    const n = BigInt(`0x${randomBytes(6).toString('hex')}`)
    uid = n.toString(36)
  } while (/^\d+$/.test(uid) || uid.length < 8)
  return uid
}

/** Generate an unused UID with a bounded retry count for the unique index. */
export function generateAvailableAlbumUid(db: DB): string {
  for (let attempt = 0; attempt < UID_GENERATION_ATTEMPTS; attempt++) {
    const uid = generateAlbumUid()
    const exists = db
      .select({ id: tables.collections.id })
      .from(tables.collections)
      .where(eq(tables.collections.uid, uid))
      .get()
    if (!exists) return uid
  }
  throw new Error('Unable to generate a unique album UID')
}

/**
 * 惰性补全相簿 UID：存量相簿首次被读取时生成并落库，兼容迁移前已存在的数据。
 * 返回最终有效的 uid。
 */
export async function ensureAlbumUid(
  db: DB,
  album: Pick<Album, 'id' | 'uid'>,
): Promise<string> {
  if (album.uid) return album.uid

  const uid = generateAvailableAlbumUid(db)

  db.update(tables.collections)
    .set({ uid, updatedAt: new Date() })
    .where(eq(tables.collections.id, album.id))
    .run()

  return uid
}
