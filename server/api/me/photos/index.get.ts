import { buildPhotoAccessContext } from '../../../utils/photo-access'
import { listManagedPhotos } from '../../../services/photo-management/list'
export default defineEventHandler(async(event)=>{
  const actor=await requireAccess(event,'user')
  return listManagedPhotos(actor,getQuery(event),await buildPhotoAccessContext(event))
})
