import { discoverablePhotoIds } from '~~/server/utils/photo-access'
import { and, eq } from 'drizzle-orm'
import z from 'zod'
import { getManualAlbumById } from '~~/server/services/collections/manual-album'
import { albumOpenToActor } from '~~/server/utils/albumVisibility'
import { hasAlbumAccess } from '~~/server/utils/manualAlbumAuth'
import { isPasswordExemptForUser } from '~~/server/utils/albumPasswordExempt'
import { isAlbumAdminBypass } from '~~/server/utils/albumAccess'

export default eventHandler(async (event) => {
  const { photoId } = await getValidatedRouterParams(
    event,
    z.object({
      photoId: z.string(),
    }).parse,
  )

  const db = useDB()
  await requireVisiblePhoto(event, photoId)

  // 获取包含该照片的所有相册
  const albums = await db
    .select({
      id: tables.collections.id,
      title: tables.collections.title,
      description: tables.collections.description,
      coverPhotoId: tables.collections.coverPhotoId,
      createdAt: tables.collections.createdAt,
      updatedAt: tables.collections.updatedAt,
    })
    .from(tables.collections)
    .innerJoin(
      tables.collectionPhotos,
      eq(tables.collections.id, tables.collectionPhotos.collectionId),
    )
    .where(
      and(
        eq(tables.collectionPhotos.photoId, photoId),
        eq(tables.collections.kind, 'manual'),
      ),
    )
    .all()

  const actor = await getActor(event)
  const adminBypass = await isAlbumAdminBypass(event, actor)
  const visibleCoverIds = await discoverablePhotoIds(
    event,
    albums.flatMap((album) => (album.coverPhotoId ? [album.coverPhotoId] : [])),
  )
  return albums
    .filter((album) => {
      const fullAlbum = getManualAlbumById(album.id)
      if (!fullAlbum || !albumOpenToActor(fullAlbum, actor)) return false
      const exempt = isPasswordExemptForUser(fullAlbum, actor.user)
      return hasAlbumAccess(
        event,
        {
          albumId: fullAlbum.id,
          passwordHash: fullAlbum.passwordHash,
          sessionExempt: exempt,
        },
        Boolean(adminBypass),
      )
    })
    .map((album) => ({
      ...album,
      coverPhotoId:
        album.coverPhotoId && visibleCoverIds.has(album.coverPhotoId)
          ? album.coverPhotoId
          : photoId,
    }))
})
