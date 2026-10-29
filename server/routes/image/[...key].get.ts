import {
  decodeMediaPath,
  respondWithPrivateMedia,
} from '../../utils/media-http'
export default eventHandler(async (event) => {
  const { storageProvider } = useStorageProvider(event)
  const rawKey = getRouterParam(event, 'key')

  if (!rawKey) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid key' })
  }

  const key = decodeMediaPath(rawKey)
  await requireStorageKeyAccess(event, key)

  const photo = await storageProvider.get(key)
  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }
  // 原图 key 唯一对应一份内容，浏览器可长期缓存
  setHeader(event, 'Cache-Control', 'private, no-cache')
  setHeader(event, 'Vary', 'Cookie')
  logger.chrono.info('Serve image from key', key)
  return respondWithPrivateMedia(event, photo)
})
