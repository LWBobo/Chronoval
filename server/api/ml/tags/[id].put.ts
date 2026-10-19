import { z } from 'zod'
import {
  assignAutoTagsForAll,
  TagConflictError,
  updateTag,
} from '~~/server/services/ml/tags.service'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(32),
  prompt: z.string().trim().max(200).optional(),
  aliases: z.array(z.string().trim().max(32)).max(20).optional(),
  enabled: z.boolean().optional(),
})

export default eventHandler(async (event) => {
  const tagId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(tagId) || tagId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid tag id' })
  }
  const body = bodySchema.parse(await readBody(event))
  try {
    const tag = updateTag(tagId, body)
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
