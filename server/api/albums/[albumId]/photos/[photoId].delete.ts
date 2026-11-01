import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { mutateCollections, assertMembershipPhotos } from '../../../../services/collections/mutations'
export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const albumId = z.coerce.number().int().positive().parse(getRouterParam(event, 'albumId'))
  const photoId = z.string().min(1).parse(getRouterParam(event, 'photoId'))
  const body = await readValidatedBody(event, z.object({ expectedAclVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict().parse)
  return mutateCollections(actor, [albumId], { [albumId]: body.expectedAclVersion }, body.reason, 'collection.member-remove', db => {
    assertMembershipPhotos([photoId], db)
    const relation = db.select().from(tables.collectionPhotos).where(and(eq(tables.collectionPhotos.collectionId, albumId), eq(tables.collectionPhotos.photoId, photoId))).get()
    if (!relation) throw createError({ statusCode: 404, message: '照片不在该相册内' })
    db.delete(tables.collectionPhotos).where(and(eq(tables.collectionPhotos.collectionId, albumId), eq(tables.collectionPhotos.photoId, photoId))).run()
    db.update(tables.collections).set({ coverPhotoId: null, updatedAt: new Date() }).where(and(eq(tables.collections.id, albumId), eq(tables.collections.coverPhotoId, photoId))).run()
    return { success: true }
  })
})
