import { assignAutoTagsForAll } from '~~/server/services/ml/tags.service'

export default eventHandler(async () => {
  const result = await assignAutoTagsForAll()
  return { success: true, photos: result.photos }
})
