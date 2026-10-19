import { and, eq, inArray, isNull } from 'drizzle-orm'
import { tables, useDB } from '~~/server/utils/db'

/**
 * 把照片追加进已有普通相簿，不改动相簿里原有的照片，也不从其它相簿移除。
 * 同一张照片可以同时属于多个相簿；已经在目标相簿里的会跳过。
 */
export function addPhotosToAlbums(albumIds: number[], photoIds: string[]) {
  const db = useDB()
  const uniqueAlbums = [...new Set(albumIds)]
  const uniquePhotos = [...new Set(photoIds.map((id) => id.trim()).filter(Boolean))]
  if (!uniqueAlbums.length || !uniquePhotos.length) {
    return { added: 0, already: 0, albums: 0 }
  }

  const existing = db
    .select({ id: tables.photos.id })
    .from(tables.photos)
    .where(
      and(inArray(tables.photos.id, uniquePhotos), isNull(tables.photos.deletedAt)),
    )
    .all()
  const validPhotos = existing.map((row) => row.id)
  if (!validPhotos.length) return { added: 0, already: 0, albums: 0 }

  let added = 0
  let already = 0
  let albums = 0

  for (const albumId of uniqueAlbums) {
    const album = db
      .select({
        id: tables.albums.id,
        coverPhotoId: tables.albums.coverPhotoId,
      })
      .from(tables.albums)
      .where(eq(tables.albums.id, albumId))
      .get()
    if (!album) continue
    albums += 1

    const rows = db
      .select({
        photoId: tables.albumPhotos.photoId,
        position: tables.albumPhotos.position,
      })
      .from(tables.albumPhotos)
      .where(eq(tables.albumPhotos.albumId, albumId))
      .all()
    const have = new Set(rows.map((row) => row.photoId))
    let position = rows.reduce((max, row) => Math.max(max, row.position), 0)

    const insert: { albumId: number; photoId: string; position: number }[] = []
    for (const photoId of validPhotos) {
      if (have.has(photoId)) {
        already += 1
        continue
      }
      position += 10
      insert.push({ albumId, photoId, position })
    }
    if (!insert.length) continue

    for (let offset = 0; offset < insert.length; offset += 80) {
      db.insert(tables.albumPhotos)
        .values(insert.slice(offset, offset + 80))
        .onConflictDoNothing()
        .run()
    }
    added += insert.length

    if (!album.coverPhotoId) {
      db.update(tables.albums)
        .set({ coverPhotoId: insert[0]!.photoId, updatedAt: new Date() })
        .where(eq(tables.albums.id, albumId))
        .run()
    }
  }

  return { added, already, albums }
}
