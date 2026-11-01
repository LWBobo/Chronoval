import { z } from 'zod'
import { initializeUpload, uploadInputSchema } from '../../../../services/uploads'
export default defineEventHandler(async event => {
  const body = await readValidatedBody(event, z.object({ ownerUserId: z.number().int().positive().nullable(), upload: uploadInputSchema }).strict().parse)
  const result = await initializeUpload(await requireAccess(event, 'admin'), body.upload, body.ownerUserId)
  setResponseStatus(event, 201)
  return result
})
