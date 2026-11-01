import { initializeUpload, uploadInputSchema } from '../../../services/uploads'
export default defineEventHandler(async (event) => {
  const actor=await requireAccess(event,'user')
  const input=await readValidatedBody(event,uploadInputSchema.parse)
  const result=await initializeUpload(actor,input)
  setResponseStatus(event,201)
  return result
})
