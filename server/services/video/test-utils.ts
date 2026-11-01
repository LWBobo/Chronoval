import { registeredFile } from '../media-files/read'
import { siteLivePhotoIds } from './scanner'

/** Administrator diagnostics stay within registered site assets and return controlled URLs. */
export function batchTestLivePhotoDetection(photoIds?: string[]) {
  const ids = siteLivePhotoIds(photoIds)
  const results = ids.flatMap(photoId => {
    const video = registeredFile(photoId, 'live_video')
    return video ? [{ photoId, found: true, videoUrl: `/api/assets/${video.id}`, videoSize: video.byteSize }] : []
  })
  return { total: ids.length, processed: ids.length, found: results.length, results }
}
