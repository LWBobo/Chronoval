/**
 * 判断照片是否为 GIF 动图（用于卡片右上角 GIF 标签等标识）。
 * GIF 入库时 type 仍为 'image'，通过原图 URL 扩展名识别。
 */
export const isGifPhoto = (photo: {
  type?: string | null
  originalUrl?: string | null
}): boolean =>
  photo.type !== 'video' &&
  /\.gif$/i.test((photo.originalUrl || '').split('?')[0])
