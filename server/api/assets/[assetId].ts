import { serveRegisteredAsset } from '../../services/media-files'
export default defineEventHandler(event=>{
 const id=getRouterParam(event,'assetId')||''
 if(!/^[a-f0-9]{32}$/.test(id))throw createError({statusCode:404,message:'File not found'})
 return serveRegisteredAsset(event,id)
})
