import { managedPhoto } from '../../../../services/photo-management'
import { withAssetUrls } from '../../../../services/media-files'
import { managedPhotoDto } from '../../../../services/photo-management/list'
export default defineEventHandler(async(event)=>{
  const actor=await requireAccess(event,'user'),id=getRouterParam(event,'id')!
  const photo=managedPhoto(actor,id)
  const recipients=useDB().select({id:tables.photoShares.recipientUserId}).from(tables.photoShares).where(eq(tables.photoShares.photoId,id)).all()
  return {...managedPhotoDto(photo,actor),recipientIds:recipients.map(p=>p.id)}
})
