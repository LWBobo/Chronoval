import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { NeededExif } from '~~/shared/types/photo'
import { locateEmbeddedMotionVideo } from '../video/motion-photo'

const STILL_EXTS = ['.jpg', '.jpeg', '.heic', '.heif', '.JPG', '.JPEG', '.HEIC', '.HEIF']
const VIDEO_EXTS = ['.mov', '.MOV']
const EMBEDDED_EXTS = new Set(['.jpg', '.jpeg', '.heic', '.heif'])
const MAX_SIDECAR_BYTES = 80 * 1024 * 1024

export const LIVE_PHOTO_CHECKED = ''

const siblingPath = async (absFile: string, exts: string[]) => {
  const dir = path.dirname(absFile)
  const base = path.basename(absFile, path.extname(absFile))
  for (const ext of exts) {
    const candidate = path.join(dir, `${base}${ext}`)
    if (candidate === absFile) continue
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_SIDECAR_BYTES) {
        return candidate
      }
    } catch {
      /* missing */
    }
  }
  return null
}

/** 苹果实况：静图旁边的同名 MOV。 */
export const findSiblingLiveVideo = (absImage: string) =>
  siblingPath(absImage, VIDEO_EXTS)

/** 这段 MOV 是否只是某张静图的实况短片。 */
export const findSiblingLiveStill = (absVideo: string) =>
  siblingPath(absVideo, STILL_EXTS)

export const libraryFileUrl = (mountName: string, rel: string) => {
  const relUrl = encodeURIComponent(rel).replace(/%2F/g, '/')
  return `/library/${mountName}/${relUrl}`
}

/**
 * 识别一张扫描库静图是不是动态照片。
 * 安卓机把短视频嵌在 JPEG/HEIC 末尾；苹果机是旁边的同名 MOV。
 */
export const detectLibraryLivePhoto = async (options: {
  photoId: string
  mountName: string
  rel: string
  absFile: string
  rawBuffer: Buffer
  exifData?: NeededExif | null
}): Promise<{
  isLivePhoto: number
  livePhotoVideoUrl: string | null
  livePhotoVideoKey: string | null
}> => {
  const ext = path.extname(options.absFile).toLowerCase()
  if (EMBEDDED_EXTS.has(ext)) {
    const embedded = locateEmbeddedMotionVideo(
      options.rawBuffer,
      options.exifData,
    )
    if (embedded) {
      return {
        isLivePhoto: 1,
        livePhotoVideoKey: `embedded:${embedded.start}`,
        livePhotoVideoUrl: `/api/photos/${options.photoId}/motion-video`,
      }
    }
  }

  const sibling = await findSiblingLiveVideo(options.absFile)
  if (sibling) {
    const dir = path.dirname(options.rel)
    const videoRel = path.posix.join(
      dir === '.' ? '' : dir.replace(/\\/g, '/'),
      path.basename(sibling),
    )
    return {
      isLivePhoto: 1,
      livePhotoVideoKey: `${options.mountName}/${videoRel}`,
      livePhotoVideoUrl: libraryFileUrl(options.mountName, videoRel),
    }
  }

  return {
    isLivePhoto: 0,
    livePhotoVideoUrl: null,
    livePhotoVideoKey: LIVE_PHOTO_CHECKED,
  }
}
