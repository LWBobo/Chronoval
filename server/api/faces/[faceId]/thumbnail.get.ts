import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { loadPhotoImageBuffer } from '~~/server/services/ml/photo-image'

export default eventHandler(async (event) => {
  const faceId = getRouterParam(event, 'faceId')
  if (!faceId) {
    throw createError({ statusCode: 400, message: 'Missing face id' })
  }

  const db = useDB()
  const face = db
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.id, faceId))
    .get()

  if (!face) {
    throw createError({ statusCode: 404, message: 'Face not found' })
  }

  const photo = db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, face.photoId))
    .get()

  if (!photo || photo.deletedAt) {
    throw createError({ statusCode: 404, message: 'Photo not found' })
  }

  setHeader(event, 'Cache-Control', 'public, max-age=86400')

  try {
    const loaded = await loadPhotoImageBuffer(face.photoId)
    if (!loaded) {
      if (photo.thumbnailUrl) {
        return sendRedirect(event, photo.thumbnailUrl, 302)
      }
      throw createError({ statusCode: 404, message: 'Image not available' })
    }

    const meta = await sharp(loaded.buffer).metadata()
    const w = meta.width || face.imageWidth || 1
    const h = meta.height || face.imageHeight || 1

    // 相对坐标 0–1 → 像素裁剪（略微外扩）
    const pad = 0.08
    const x1 = Math.max(0, face.x1 - pad)
    const y1 = Math.max(0, face.y1 - pad)
    const x2 = Math.min(1, face.x2 + pad)
    const y2 = Math.min(1, face.y2 + pad)

    const left = Math.floor(x1 * w)
    const top = Math.floor(y1 * h)
    const width = Math.max(1, Math.floor((x2 - x1) * w))
    const height = Math.max(1, Math.floor((y2 - y1) * h))

    const crop = await sharp(loaded.buffer)
      .extract({
        left,
        top,
        width: Math.min(width, w - left),
        height: Math.min(height, h - top),
      })
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer()

    setHeader(event, 'Content-Type', 'image/jpeg')
    return crop
  } catch (err: any) {
    if (err?.statusCode) throw err
    // sharp 失败时回退到照片缩略图
    if (photo.thumbnailUrl) {
      return sendRedirect(event, photo.thumbnailUrl, 302)
    }
    throw createError({
      statusCode: 500,
      message: err instanceof Error ? err.message : 'Failed to crop face',
    })
  }
})
