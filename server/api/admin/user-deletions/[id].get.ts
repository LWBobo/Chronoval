import { deletionDto } from '../../../services/users/deletion'
export default defineEventHandler(async event => {
  await requireAccess(event, 'admin')
  return deletionDto(getRouterParam(event, 'id')!)
})
