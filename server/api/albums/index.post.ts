import { eq } from 'drizzle-orm'
import z from 'zod'
import { collectionAccessSchema, replaceCollectionPolicy } from '../../services/collections/access'
import { assertCurrentActor } from '../../services/users'
import { assertMembershipPhotos } from '../../services/collections/mutations'
import { generateAlbumUid } from '~~/server/utils/albumUid'
import { toManualAlbum } from '~~/server/services/collections/manual-album'

export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(
    event,
    z.object({
      access: collectionAccessSchema,
      title: z.string().min(1).max(255),
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
  const slug = body.slug?.trim() || null
  if (slug) {
    const duplicate = db
      .select({ id: tables.collections.id })
      .from(tables.collections)
      .where(eq(tables.collections.slug, slug))
      .get()
    if (duplicate) {
      throw createError({ statusCode: 409, statusMessage: 'Slug already in use' })
    }
  }

  const created = db.transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    const album = tx
      .insert(tables.collections)
      .values({
        kind: 'manual',
        title: body.title,
        description: body.description || null,
        coverPhotoId: body.coverPhotoId || null,
        showOnGallery: !body.hideFromGallery,
        showOnAlbums: true,
        layout: body.layout ?? 'waterfall',
        randomAnimation:
          body.randomAnimation ?? (body.randomWheelAnimation ? 'wheel' : 'default'),
        randomQuotesEnabled: body.randomQuotesEnabled ?? true,
        randomQuotes: body.randomQuotes || null,
        randomQuotesTag: body.randomQuotesTag || null,
        bgmMusicId: body.bgmMusicId ?? null,
        uid: generateAlbumUid(),
        slug,
      })
      .returning()
      .get()

    replaceCollectionPolicy(album.id, body.access, actor, tx as any)

    const photoIds = new Set(body.photoIds || [])
    if (body.coverPhotoId) photoIds.add(body.coverPhotoId)
    if (photoIds.size) assertMembershipPhotos([...photoIds], tx as any)
    let position = 1000000
    for (const photoId of photoIds) {
      tx.insert(tables.collectionPhotos)
        .values({
          collectionId: album.id,
          photoId,
          position: (position += 10),
        })
        .onConflictDoNothing()
        .run()
    }
    return tx.select().from(tables.collections).where(eq(tables.collections.id, album.id)).get()!
  }, { behavior: 'immediate' })

  const album = toManualAlbum(created, db)
  const { passwordHash: _passwordHash, ...safeAlbum } = album
  return safeAlbum
})
