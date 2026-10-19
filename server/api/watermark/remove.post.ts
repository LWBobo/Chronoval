import { z } from 'zod'
import { removeMountedWatermarks } from '~~/server/services/image/watermark-library'

const bodySchema = z.object({
  files: z
    .array(
      z.object({
        mount: z.string().min(1).max(128),
        relPath: z.string().min(1).max(4096),
      }),
    )
    .min(1)
    .max(500),
})

export default defineEventHandler(async (event) => {
  const body = bodySchema.parse(await readBody(event))
  const results = await removeMountedWatermarks(body.files)
  const cleaned = results.filter((item) => item.ok).length
  return { cleaned, failed: results.length - cleaned, results }
})
