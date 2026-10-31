import {
  assertMethod,
  getHeader,
  getRouterParam,
  setHeader,
  setResponseStatus,
  sendStream,
  sendNoContent,
  createError,
} from 'h3'
import libraryHandler from '../../routes/library/[...path]'
import storageHandler from '../../routes/storage/[...path]'
import motionHandler from '../photos/[photoId]/motion-video.get'
import { parsePhotoAssetId } from '../../utils/asset-reference'
import { requireVisiblePhoto } from '../../utils/photo-access'

/** Read existing resources directly: no redirect and no client-supplied filesystem path. */
export default eventHandler(async (event) => {
  assertMethod(event, ['GET', 'HEAD'])
  const asset = parsePhotoAssetId(getRouterParam(event, 'assetId') || '')
  if (!asset) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const { photo } = await requireVisiblePhoto(event, asset.photoId, {
    allowAdminDeleted: true,
  })
  const reference =
    asset.kind === 'original'
      ? photo.type === 'video' && photo.originalUrl
      : photo.isLivePhoto && photo.livePhotoVideoUrl
  if (!reference)
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const previousParams = event.context.params
  try {
    if (
      asset.kind === 'live' &&
      photo.livePhotoVideoKey?.startsWith('embedded:')
    ) {
      event.context.params = { photoId: photo.id }
      const result = await motionHandler(event)
      if (event.method === 'HEAD' && result === null && !event.handled)
        return sendNoContent(event, event.node.res.statusCode)
      return result
    }

    const url = new URL(reference, 'http://asset.internal')
    if (reference.startsWith('/library/')) {
      event.context.params = { path: url.pathname.slice('/library/'.length) }
      return await libraryHandler(event)
    }
    if (reference.startsWith('/storage/')) {
      event.context.params = { path: url.pathname.slice('/storage/'.length) }
      return await storageHandler(event)
    }

    // External storage is fetched on the server so its original URL never reaches the player.
    if (!/^https?:\/\//i.test(reference))
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    for (const name of [
      'range',
      'if-none-match',
      'if-modified-since',
      'if-range',
    ]) {
      const value = getHeader(event, name)
      if (value) headers[name] = value
    }
    const upstream = await fetch(reference, {
      method: event.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
    })
    if (![200, 206, 304, 416].includes(upstream.status)) {
      await upstream.body?.cancel()
      throw createError({ statusCode: 502, statusMessage: 'Asset unavailable' })
    }
    setResponseStatus(event, upstream.status)
    setHeader(event, 'Cache-Control', 'private, no-cache')
    setHeader(event, 'Vary', 'Cookie')
    for (const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified',
    ]) {
      const value = upstream.headers.get(name)
      if (value) setHeader(event, name, value)
    }
    if (event.method === 'HEAD' || upstream.status === 304 || !upstream.body) {
      await upstream.body?.cancel()
      return sendNoContent(event, upstream.status)
    }
    return sendStream(event, upstream.body)
  } finally {
    event.context.params = previousParams
  }
})
