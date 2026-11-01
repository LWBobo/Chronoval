import { uploadDto } from '../../../../services/uploads'
export default defineEventHandler(async(event)=>uploadDto(getRouterParam(event,'id')!,await requireAccess(event,'user')))
