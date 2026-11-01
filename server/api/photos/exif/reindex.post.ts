import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { managedPhoto } from '../../../services/photo-management'
import { registeredFileBuffer } from '../../../services/media-files/read'
import { extractExifData } from '../../../services/image/exif'
export default defineEventHandler(async event=>{
 const actor=await requireAccess(event,'admin')
 const input=await readValidatedBody(event,z.object({action:z.enum(['single-reindex','batch-reindex']),photoId:z.string().optional(),photoIds:z.array(z.string()).max(500).optional()}).strict().parse)
 const ids=input.action==='single-reindex'?[z.string().min(1).parse(input.photoId)]:input.photoIds??useDB().select({id:tables.photos.id}).from(tables.photos).limit(500).all().map(p=>p.id)
 const results=[]
 for(const id of ids){try{
   const photo=managedPhoto(actor,id)
   if(photo.processingStatus!=='ready'||photo.transferState!=='idle'||photo.stripLocation)throw new Error('照片状态暂不支持重索引')
   const exif=await extractExifData(await registeredFileBuffer(id,['original']))
   useDB().transaction(tx=>{const current=managedPhoto(actor,id,tx as any);if(current.metadataVersion!==photo.metadataVersion||current.transferState!=='idle')throw new Error('Photo changed');tx.update(tables.photos).set({exif,updatedAt:new Date()}).where(eq(tables.photos.id,id)).run()},{behavior:'immediate'})
   results.push({photoId:id,success:true})
 }catch(error:any){results.push({photoId:id,success:false,message:error.message})}}
 return {success:results.every(r=>r.success),results}
})
