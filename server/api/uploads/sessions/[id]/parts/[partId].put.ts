import { receiveUpload } from '../../../../../services/uploads'
export default defineEventHandler(async(event)=>receiveUpload(event,await requireAccess(event,'user'),getRouterParam(event,'id')!,getRouterParam(event,'partId')!))
