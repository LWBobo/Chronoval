import { cancelUpload } from '../../../../services/uploads/cleanup'
export default defineEventHandler(async(event)=>cancelUpload(getRouterParam(event,'id')!,await requireAccess(event,'user')))
