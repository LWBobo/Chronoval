import { changeVisibilityBatch,photoVisibilityBatchSchema } from '../../../services/photo-management/batch'
export default defineEventHandler(async event=>{
  const actor=await requireAccess(event,'user')
  const input=await readValidatedBody(event,photoVisibilityBatchSchema.parse)
  return changeVisibilityBatch(actor,input)
})
