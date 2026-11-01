import { registeredFile } from '../../../services/media-files/read'
import { serveRegisteredAsset } from '../../../services/media-files'
export default defineEventHandler(event=>{
 const file=registeredFile(getRouterParam(event,'photoId')!,'live_video')
 if(!file)throw createError({statusCode:404,message:'File not found'})
 return serveRegisteredAsset(event,file.id)
})
