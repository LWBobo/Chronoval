// 扫描相簿目录照片：缩略图/原图供瀑布流与查看器使用，
// exif 与尺寸等字段供查看器的表态和拍摄参数面板使用。
import type { NeededExif } from '~~/shared/types/photo'

export interface ScanPhoto {
  id: string
  thumbnailUrl: string | null
  thumbnailHash: string | null
  aspectRatio: number | null
  originalUrl: string | null
  /** 展示标题（如文件主名），供查看器工具栏展示 */
  title?: string | null
  /** 拍摄时间（ISO 字符串），供查看器工具栏展示 */
  dateTaken?: string | null
  isLivePhoto?: number
  livePhotoVideoUrl?: string | null
  exif?: NeededExif | null
  width?: number | null
  height?: number | null
  fileSize?: number | null
  storageKey?: string | null
  tags?: string[] | null
  latitude?: number | null
  longitude?: number | null
  city?: string | null
  country?: string | null
  type?: 'image' | 'video'
}