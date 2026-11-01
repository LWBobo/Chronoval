import { completeUpload } from '../../../../services/uploads'
export default defineEventHandler(async(event)=>completeUpload(getRouterParam(event,'id')!,await requireAccess(event,'user')))
