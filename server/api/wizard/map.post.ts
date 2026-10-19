import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { mapPmtilesFilename } from '~~/shared/map-pmtiles'

export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({
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
      })
      .parse,
  )

  await settingsManager.set('map', 'provider', body.provider)

  if (body.provider === 'mapbox') {
    await settingsManager.set('map', 'mapbox.token', body.token || '')
    if (body.style) await settingsManager.set('map', 'mapbox.style', body.style)
  } else if (body.provider === 'maplibre') {
    await settingsManager.set('map', 'maplibre.token', body.token || '')
    if (body.style)
      await settingsManager.set('map', 'maplibre.style', body.style)
  } else if (body.file) {
    try {
      mapPmtilesFilename(body.file)
    } catch (error) {
      throw createError({
        statusCode: 400,
        statusMessage:
          error instanceof Error ? error.message : 'Invalid map file',
      })
    }
    await settingsManager.set('map', 'protomaps.file', body.file)
  }

  return { success: true }
})
