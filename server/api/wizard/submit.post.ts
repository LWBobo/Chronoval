import { z } from 'zod'
import { createAccount, createUserSchema, usernameSchema, passwordSchema } from '../../services/users'
import { normalizeEmail } from '../../utils/identity'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { mapPmtilesFilename } from '~~/shared/map-pmtiles'
import { storageConfigSchema } from '~~/shared/types/storage'
import { useDB, tables, eq } from '~~/server/utils/db'

export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({
      admin: z.object({
        email: z.email().transform(normalizeEmail),
        password: passwordSchema,
        username: usernameSchema.default('admin'),
      }),
      site: z.object({
        title: z.string().min(1),
        slogan: z.string().optional(),
        avatarUrl: z.string().optional(),
        author: z.string().optional(),
      }),
      storage: z.object({
        name: z.string().min(1),
        config: storageConfigSchema,
      }),
      map: z
        .object({
          provider: z.enum(['mapbox', 'maplibre', 'protomaps']),
          token: z.string().optional(),
          style: z.string().optional(),
          file: z.string().optional(),
        })
        .superRefine((value, ctx) => {
          if (value.provider !== 'protomaps' && !value.token?.trim()) {
            ctx.addIssue({
              code: 'custom',
              path: ['token'],
              message: 'Map token is required',
            })
          }
        }),
    }).parse,
  )

  const db = useDB()

  let adminUser: typeof tables.users.$inferSelect | undefined
  const existing = db.select().from(tables.users).limit(1).get()
  if (existing) {
    if (existing.role !== 'admin' || existing.status !== 'active' || existing.emailKey !== body.admin.email || existing.username !== body.admin.username || !(await verifyPassword(existing.password || '', body.admin.password))) {
      throw createError({ statusCode: 409, message: 'Initial administrator already exists' })
    }
    adminUser = existing
  } else {
    const result = await createAccount(createUserSchema.parse({ ...body.admin, quotaBytes: null }), null, 'admin')
    adminUser = db.select().from(tables.users).where(eq(tables.users.id, result.user.id)).get()
  }

  // 2. Handle Site Settings
  await settingsManager.set('app', 'title', body.site.title)
  if (body.site.slogan)
    await settingsManager.set('app', 'slogan', body.site.slogan)
  if (body.site.avatarUrl)
    await settingsManager.set('app', 'avatarUrl', body.site.avatarUrl)
  if (body.site.author)
    await settingsManager.set('app', 'author', body.site.author)

  // 3. Handle Storage Settings
  // Check if provider already exists to avoid duplicates if re-running?
  // For now, just add it.
  const id = await settingsManager.storage.addProvider({
    name: body.storage.name,
    provider: body.storage.config.provider,
    config: body.storage.config,
  })
  await settingsManager.set('storage', 'provider', id)

  // 4. Handle Map Settings
  await settingsManager.set('map', 'provider', body.map.provider)
  if (body.map.provider === 'mapbox') {
    await settingsManager.set('map', 'mapbox.token', body.map.token || '')
    if (body.map.style)
      await settingsManager.set('map', 'mapbox.style', body.map.style)
  } else if (body.map.provider === 'maplibre') {
    await settingsManager.set('map', 'maplibre.token', body.map.token || '')
    if (body.map.style)
      await settingsManager.set('map', 'maplibre.style', body.map.style)
  } else if (body.map.file) {
    try {
      mapPmtilesFilename(body.map.file)
    } catch (error) {
      throw createError({
        statusCode: 400,
        statusMessage:
          error instanceof Error ? error.message : 'Invalid map file',
      })
    }
    await settingsManager.set('map', 'protomaps.file', body.map.file)
  }

  // 5. Mark Complete
  await settingsManager.set('system', 'firstLaunch', false, undefined, true)

  // 6. Auto-login the admin user
  if (adminUser) {
    await establishUserSession(event, adminUser)
  }

  return { success: true }
})
