import { eq } from 'drizzle-orm'
import z from 'zod'
import { hashAlbumPassword } from '~~/server/utils/scanAlbumPassword'
import { generateAlbumUid } from '~~/server/utils/albumUid'
import { replaceCollectionAccess } from '~~/server/services/collections/access-grants'
import { toManualAlbum } from '~~/server/services/collections/manual-album'

export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({
      title: z.string().min(1).max(255),
      description: z.string().max(1000).optional(),
      coverPhotoId: z.string().optional(),
      photoIds: z.array(z.string()).optional(),
      isHidden: z.boolean().optional(),
      visibility: z.enum(['public', 'login', 'admin']).optional(),
      hideFromGallery: z.boolean().optional(),
      layout: z.enum(['waterfall', 'grid', 'immersive', 'timeline']).optional(),
      randomAnimation: z.enum(['default', 'wheel', 'compat']).optional(),
      randomWheelAnimation: z.boolean().optional(),
      randomQuotesEnabled: z.boolean().optional(),
      randomQuotes: z.string().max(5000).nullable().optional(),
      randomQuotesTag: z.enum(['ancient', 'modern']).nullable().optional(),
      bgmMusicId: z.number().int().nullable().optional(),
      password: z.string().max(128).optional(),
      passwordExemptMode: z.enum(['logged_in', 'selected']).nullable().optional(),
      passwordExemptUsers: z.array(z.string().max(255)).nullable().optional(),
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
  const visibility = body.visibility ?? (body.isHidden ? 'login' : 'public')
  const passwordHash = body.password?.trim()
    ? hashAlbumPassword(body.password.trim())
    : null
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
        passwordHash,
        uid: generateAlbumUid(),
        slug,
      })
      .returning()
      .get()

    replaceCollectionAccess(
      album.id,
      {
        visibility,
        passwordExemptMode: passwordHash
          ? body.passwordExemptMode === 'selected' &&
            !body.passwordExemptUsers?.length
            ? null
            : body.passwordExemptMode
          : null,
        passwordExemptUsers: passwordHash ? body.passwordExemptUsers : null,
      },
      tx,
    )

    const photoIds = new Set(body.photoIds || [])
    if (body.coverPhotoId) photoIds.add(body.coverPhotoId)
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
    return album
  })

  const album = toManualAlbum(created, db)
  const { passwordHash: _passwordHash, ...safeAlbum } = album
  return safeAlbum
})
