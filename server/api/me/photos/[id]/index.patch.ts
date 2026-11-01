import { z } from 'zod'
import { editPhotoMetadata } from '../../../../services/photo-management'
import { managedPhotoDto } from '../../../../services/photo-management/list'
export default defineEventHandler(async(event)=>{
  const input=await readValidatedBody(event,z.object({expectedVersion:z.number().int().positive(),title:z.string().trim().max(512).optional(),description:z.string().trim().max(2000).optional(),tags:z.array(z.string().trim().max(128)).max(64).optional(),isPanorama:z.number().int().min(0).max(1).nullable().optional(),panoYaw:z.number().min(-360).max(360).nullable().optional(),panoPitch:z.number().min(-89).max(89).nullable().optional(),latitude:z.number().min(-90).max(90).nullable().optional(),longitude:z.number().min(-180).max(180).nullable().optional(),reason:z.string().trim().max(1000).optional()}).strict().parse)
  const actor = await requireAccess(event,'user')
  return managedPhotoDto(editPhotoMetadata(actor,getRouterParam(event,'id')!,input),actor)
})
