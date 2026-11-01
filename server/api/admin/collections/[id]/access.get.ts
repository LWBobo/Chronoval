import { collectionAccessDto } from '../../../../services/collections/access'
export default defineEventHandler(async (event) => {
  await requireAccess(event, 'admin')
  return collectionAccessDto(Number(getRouterParam(event, 'id')))
})
