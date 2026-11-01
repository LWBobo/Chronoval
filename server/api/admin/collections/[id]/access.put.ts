import { collectionAccessSchema, replaceCollectionPolicy } from '../../../../services/collections/access'
export default defineEventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const input = await readValidatedBody(event, collectionAccessSchema.parse)
  return replaceCollectionPolicy(Number(getRouterParam(event, 'id')), input, actor)
})
