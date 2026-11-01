import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { collectionAccessSchema, replaceCollectionPolicy } from '../../../services/collections/access'
import { assertCurrentActor, audit } from '../../../services/users'
import { assertCollectionVersion, assertMembershipPhotos } from '../../../services/collections/mutations'
import { getManualAlbumById, toManualAlbum } from '~~/server/services/collections/manual-album'

export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({
      albumId: z.string().regex(/^\d+$/).transform(Number),
    }).strict().parse,
  )
  const body = await readValidatedBody(
    event,
    z.object({
      access: collectionAccessSchema.optional(),
      expectedAclVersion: z.number().int().positive().optional(),
      reason: z.string().trim().min(1).max(1000).optional(),
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(1000).optional(),
      coverPhotoId: z.string().optional(),
      photoIds: z.array(z.string()).optional(),
      hideFromGallery: z.boolean().optional(),
      layout: z.enum(['waterfall', 'grid', 'immersive', 'timeline']).optional(),
      randomAnimation: z.enum(['default', 'wheel', 'compat']).optional(),
      randomWheelAnimation: z.boolean().optional(),
      randomQuotesEnabled: z.boolean().optional(),
      randomQuotes: z.string().max(5000).nullable().optional(),
      randomQuotesTag: z.enum(['ancient', 'modern']).nullable().optional(),
      bgmMusicId: z.number().int().nullable().optional(),
      slug: z
        .string()
        .max(120)
        .nullable()
        .optional()
        .transform((value) =>
          value
            ? value
                .replace(/[^a-zA-Z0-9-_]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
            : value,
        ),
    }).strict().parse,
  )

  const db = useDB()
  const current = getManualAlbumById(albumId)
  if (!current) {
    throw createError({ statusCode: 404, statusMessage: 'Album not found' })
  }

  const nextSlug = body.slug === undefined ? undefined : body.slug?.trim() || null
  if (nextSlug) {
    const duplicate = db
      .select({ id: tables.collections.id })
      .from(tables.collections)
      .where(eq(tables.collections.slug, nextSlug))
      .all()
      .find((row) => row.id !== albumId)
    if (duplicate) {
      throw createError({ statusCode: 409, statusMessage: 'Slug already in use' })
    }
  }

  const updated = db.transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    if (body.photoIds !== undefined || body.coverPhotoId !== undefined) {
      assertCollectionVersion(albumId, body.expectedAclVersion ?? body.access?.expectedAclVersion, tx as any)
      if (!body.reason && !body.access?.reason) throw createError({ statusCode: 422, message: '修改成员须填写原因' })
      const ids = [...(body.photoIds ?? []), ...(body.coverPhotoId ? [body.coverPhotoId] : [])]
      if (ids.length) assertMembershipPhotos(ids, tx as any)
      if (body.photoIds === undefined && body.coverPhotoId && !tx.select().from(tables.collectionPhotos).where(and(eq(tables.collectionPhotos.collectionId, albumId), eq(tables.collectionPhotos.photoId, body.coverPhotoId))).get()) throw createError({ statusCode: 422, message: '封面必须属于当前相册' })
    }
    const patch: Partial<typeof tables.collections.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (body.title !== undefined) patch.title = body.title
    if (body.description !== undefined)
      patch.description = body.description || null
    if (body.coverPhotoId !== undefined)
      patch.coverPhotoId = body.coverPhotoId || null
    if (body.hideFromGallery !== undefined)
      patch.showOnGallery = !body.hideFromGallery
    if (body.layout !== undefined) patch.layout = body.layout
    if (body.randomAnimation !== undefined)
      patch.randomAnimation = body.randomAnimation
    else if (body.randomWheelAnimation !== undefined)
      patch.randomAnimation = body.randomWheelAnimation ? 'wheel' : 'default'
    if (body.randomQuotesEnabled !== undefined)
      patch.randomQuotesEnabled = body.randomQuotesEnabled
    if (body.randomQuotes !== undefined)
      patch.randomQuotes = body.randomQuotes || null
    if (body.randomQuotesTag !== undefined)
      patch.randomQuotesTag = body.randomQuotesTag || null
    if (body.bgmMusicId !== undefined) patch.bgmMusicId = body.bgmMusicId
    if (nextSlug !== undefined) patch.slug = nextSlug
    tx.update(tables.collections)
      .set(patch)
      .where(
        and(
          eq(tables.collections.id, albumId),
          eq(tables.collections.kind, 'manual'),
        ),
      )
      .run()

    if (body.access) replaceCollectionPolicy(albumId, body.access, actor, tx as any)

    if (body.photoIds !== undefined) {
      tx.delete(tables.collectionPhotos)
        .where(eq(tables.collectionPhotos.collectionId, albumId))
        .run()
      const photoIds = new Set(body.photoIds)
      if (body.coverPhotoId) photoIds.add(body.coverPhotoId)
      let position = 1000000
      for (const photoId of photoIds) {
        tx.insert(tables.collectionPhotos)
          .values({
            collectionId: albumId,
            photoId,
            position: (position += 10),
          })
          .onConflictDoNothing()
          .run()
      }
      audit(tx as any, actor.user!.id, 'collection.members-replace', 'collection', albumId, { reason: body.reason ?? body.access?.reason, after: { count: photoIds.size } })
    }

    if (body.photoIds === undefined && body.coverPhotoId !== undefined) {
      if (!body.access) tx.update(tables.collections).set({ aclVersion: sql`${tables.collections.aclVersion}+1` }).where(eq(tables.collections.id, albumId)).run()
      audit(tx as any, actor.user!.id, 'collection.cover-update', 'collection', albumId, { reason: body.reason ?? body.access?.reason, after: { coverPhotoId: body.coverPhotoId || null } })
    }

    return tx
      .select()
      .from(tables.collections)
      .where(eq(tables.collections.id, albumId))
      .get()!
  }, { behavior: 'immediate' })

  const album = toManualAlbum(updated, db)
  const { passwordHash: _passwordHash, ...safeAlbum } = album
  return safeAlbum
})
