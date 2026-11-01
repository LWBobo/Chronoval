import { z } from 'zod'
import { moderatePhoto } from '../../../../services/photo-management'
export default defineEventHandler(async(event)=>{
  const input=await readValidatedBody(event,z.object({blocked:z.boolean(),reason:z.string().trim().min(1).max(1000)}).strict().parse)
  return moderatePhoto(await requireAccess(event,'admin'),getRouterParam(event,'id')!,input)
})
