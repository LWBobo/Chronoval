import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { hashAlbumPassword } from '~~/server/utils/scanAlbumPassword'
import {
  readCollectionAccess,
  replaceCollectionAccess,
} from '~~/server/services/collections/access-grants'
import { getManualAlbumById, toManualAlbum } from '~~/server/services/collections/manual-album'

export default eventHandler(async (event) => {
  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({
      albumId: z.string().regex(/^\d+$/).transform(Number),
    }).parse,
  )
  const body = await readValidatedBody(
    event,
    z.object({
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(1000).optional(),
      coverPhotoId: z.string().optional(),
      photoIds: z.array(z.string()).optional(),
      isHidden: z.boolean().optional(),
      visibility: z.enum(['public', 'login', 'admin']).optional(),
      hideFromGallery: z.boolean().optional(),
      password: z.string().max(128).optional(),
      clearPassword: z.boolean().optional(),
      passwordExemptMode: z.enum(['logged_in', 'selected']).nullable().optional(),
      passwordExemptUsers: z.array(z.string().max(255)).nullable().optional(),
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
    }).parse,
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
    if (body.clearPassword) patch.passwordHash = null
    else if (body.password?.trim())
      patch.passwordHash = hashAlbumPassword(body.password.trim())

    tx.update(tables.collections)
      .set(patch)
      .where(
        and(
          eq(tables.collections.id, albumId),
          eq(tables.collections.kind, 'manual'),
        ),
      )
      .run()

    if (
      body.visibility !== undefined ||
      body.isHidden !== undefined ||
      body.clearPassword ||
      body.passwordExemptMode !== undefined ||
      body.passwordExemptUsers !== undefined
    ) {
      const access = readCollectionAccess(albumId, tx)
      replaceCollectionAccess(
        albumId,
        {
          visibility:
            body.visibility ??
            (body.isHidden === undefined
              ? access.visibility
              : body.isHidden
                ? 'login'
                : 'public'),
          passwordExemptMode:
            body.clearPassword
              ? null
              : body.passwordExemptMode === undefined
              ? access.passwordExemptMode
              : body.passwordExemptMode === 'selected' &&
                  !body.passwordExemptUsers?.length
                ? null
                : body.passwordExemptMode,
          passwordExemptUsers:
            body.clearPassword
              ? null
              : body.passwordExemptUsers === undefined
              ? access.passwordExemptUsers
              : body.passwordExemptUsers,
        },
        tx,
      )
    }

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
    }

    return tx
      .select()
      .from(tables.collections)
      .where(eq(tables.collections.id, albumId))
      .get()!
  })

  const album = toManualAlbum(updated, db)
  const { passwordHash: _passwordHash, ...safeAlbum } = album
  return safeAlbum
})
