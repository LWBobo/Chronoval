import { z } from 'zod'
import { managedPhoto, editPhotoMetadata } from '../../../services/photo-management'
import { withAssetUrls } from '../../../services/media-files'
const schema = z.object({
  expectedVersion:z.number().int().positive(), title:z.string().trim().max(512).optional(),description:z.string().trim().max(2000).optional(),tags:z.array(z.string().trim().max(128)).max(64).optional(),
  location:z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict().nullable().optional(),rating:z.number().int().min(0).max(5).nullable().optional(),isPanorama:z.union([z.literal(0),z.literal(1)]).nullable().optional(),panoYaw:z.number().min(-360).max(360).nullable().optional(),panoPitch:z.number().min(-89).max(89).nullable().optional(),reason:z.string().trim().max(1000).optional()
}).strict()
export default defineEventHandler(async event=>{
  const actor=await requireAccess(event,'admin'), id=getRouterParam(event,'photoId')!
  const input=await readValidatedBody(event,schema.parse)
  const {location,...rest}=input
  const photo=editPhotoMetadata(actor,id,{...rest,...(location!==undefined?{latitude:location?.latitude??null,longitude:location?.longitude??null}:{})})
  return {success:true,photo:withAssetUrls(photo,true)}
})
