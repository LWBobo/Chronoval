import { z } from 'zod'
import { changePhotoVisibility } from '../../../../services/photo-management'
export default defineEventHandler(async(event)=>{
  const input=await readValidatedBody(event,z.object({expectedAclVersion:z.number().int().positive(),visibility:z.enum(['private','public','shared']),recipientIds:z.array(z.number().int().positive()).max(500),reason:z.string().trim().max(1000).optional()}).strict().parse)
  return changePhotoVisibility(await requireAccess(event,'user'),getRouterParam(event,'id')!,input)
})
