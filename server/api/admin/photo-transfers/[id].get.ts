import { transferDto } from '../../../services/photo-management/transfer'
export default defineEventHandler(async(event)=>{
  await requireAccess(event,'admin')
  return transferDto(getRouterParam(event,'id')!)
})
