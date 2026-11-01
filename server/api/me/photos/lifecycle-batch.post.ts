import { changeLifecycleBatch, photoLifecycleBatchSchema } from '../../../services/photo-management/batch'

export default defineEventHandler(async event => {
  const actor = await requireAccess(event, 'user')
  const input = await readValidatedBody(event, photoLifecycleBatchSchema.parse)
  return changeLifecycleBatch(actor, input)
})
