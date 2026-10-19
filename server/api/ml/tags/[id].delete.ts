import { deleteTag } from '~~/server/services/ml/tags.service'

export default eventHandler((event) => {
  const tagId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(tagId) || tagId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid tag id' })
  }
  deleteTag(tagId)
  return { success: true }
})
