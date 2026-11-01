import { decodeMediaPath } from '../../utils/media-http'
import { requireLibraryMediaAccess } from '../../utils/media-access'
import { registeredFile } from '../../services/media-files/read'
import { serveRegisteredAsset } from '../../services/media-files'

export default eventHandler(async (event) => {
  const raw = getRouterParam(event, 'path') || ''
  const slash = raw.indexOf('/')
  if (slash < 1) throw createError({ statusCode: 404, message: 'File not found' })
  const { file } = await requireLibraryMediaAccess(event, raw.slice(0, slash), decodeMediaPath(raw.slice(slash + 1)))
  // Legacy bookmarks use the registry, authorization, Range and HEAD path.
  const preview = file.role === 'original' && getQuery(event).original !== '1' && getQuery(event).download !== '1'
    ? registeredFile(file.photoId, 'preview') : null
  return serveRegisteredAsset(event, preview?.id ?? file.id)
})
