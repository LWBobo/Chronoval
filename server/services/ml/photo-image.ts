import { currentMlPhoto, type PhotoPartition } from './partition'
import { registeredFile } from '../media-files/read'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { getGlobalStorageManager } from '../storage'

const ML_MAX_EDGE = 1280

/** Longest edge ≤ 1280 JPEG, so CLIP / faces / OCR see a bounded image. */
async function prepareMlImage(
  buffer: Buffer,
  filename: string,
): Promise<{ buffer: Buffer; filename: string }> {
  try {
    const out = await sharp(buffer, { failOn: 'none', animated: false })
      .rotate()
      .resize({
        width: ML_MAX_EDGE,
        height: ML_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92 })
      .toBuffer()
    const base = filename.replace(/\.[^.]+$/, '') || 'image'
    return { buffer: out, filename: `${base}.jpg` }
  } catch (err) {
    throw new Error(
      `Unable to prepare image for ML (${filename}): ${err instanceof Error ? err.message : err}`,
    )
  }
}
export async function loadPhotoImageBuffer(
  photoId: string,
): Promise<{ buffer: Buffer; filename: string; snapshot: PhotoPartition & { checksum:string|null; originalVersion:number } } | null> {
  const db = useDB()
  const photo = db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
  if (!photo || photo.deletedAt) return null

  if(photo.transferState!=='idle'||photo.processingStatus!=='ready')return null
  if(photo.ownerId){const owner=db.select({status:tables.users.status}).from(tables.users).where(eq(tables.users.id,photo.ownerId)).get();if(owner?.status!=='active')return null}
  const { registeredFileBuffer }=await import('../media-files/read')
  const original=registeredFile(photoId,'original')
  if(!original)return null
  const snapshot={ownershipType:photo.ownershipType,ownerId:photo.ownerId,checksum:photo.contentChecksum,originalVersion:original.contentVersion}
  const raw=await registeredFileBuffer(photoId,['preview','thumbnail','original'])
  return {...await prepareMlImage(raw,photo.originalFilename||`${photoId}.jpg`),snapshot}
}
