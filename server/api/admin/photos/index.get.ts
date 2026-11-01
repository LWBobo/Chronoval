import { buildPhotoAccessContext } from '../../../utils/photo-access'
import { listManagedPhotos } from '../../../services/photo-management/list'
export default defineEventHandler(async event => listManagedPhotos(await requireAccess(event, 'admin'), getQuery(event), await buildPhotoAccessContext(event), true))
