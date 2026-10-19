import { listTags } from '~~/server/services/ml/tags.service'

export default eventHandler(() => {
  return { tags: listTags() }
})
