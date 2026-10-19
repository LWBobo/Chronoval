import { z } from 'zod'
import {
  assignAutoTagsForAll,
  createTag,
  TagConflictError,
} from '~~/server/services/ml/tags.service'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(32),
  prompt: z.string().trim().max(200).optional(),
  aliases: z.array(z.string().trim().max(32)).max(20).optional(),
  enabled: z.boolean().optional(),
})

export default eventHandler(async (event) => {
  const body = bodySchema.parse(await readBody(event))
  try {
    const tag = createTag(body)
    let photos = 0
    if (tag.enabled) {
      try {
        photos = (await assignAutoTagsForAll()).photos
      } catch {
        /* 标签已保存；向量服务不可用时稍后再打 */
      }
    }
    return { tag, photos }
  } catch (err) {
    if (err instanceof TagConflictError) {
      throw createError({ statusCode: 409, statusMessage: err.message })
    }
    throw err
  }
})
