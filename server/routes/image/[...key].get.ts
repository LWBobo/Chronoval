import { decodeMediaPath } from '../../utils/media-http'
import { requireStorageKeyAccess } from '../../utils/media-access'
import { serveRegisteredAsset } from '../../services/media-files'
export default defineEventHandler(async event=>{
 const {file}=await requireStorageKeyAccess(event,decodeMediaPath(getRouterParam(event,'key')||''))
 return serveRegisteredAsset(event,file.id)
})
