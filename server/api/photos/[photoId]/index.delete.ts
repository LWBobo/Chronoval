import { photoLifecycle } from '../../../services/photo-management'
export default defineEventHandler(async event => photoLifecycle(await requireAccess(event,'admin'),getRouterParam(event,'photoId')!,'trash'))
