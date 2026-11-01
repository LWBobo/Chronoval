import { and, eq, isNotNull, lt, notInArray } from 'drizzle-orm'
import type { StorageProvider } from '../storage'
import { useDB, tables, type Photo } from '../../utils/db'
import { purgeRegisteredPhoto } from '../photo-management/purge'

export async function permanentlyDeletePhoto(photo: Photo, _provider?: StorageProvider): Promise<void> {
  useDB().transaction(tx => {
    const current = tx.select().from(tables.photos).where(eq(tables.photos.id,photo.id)).get()
    if (!current) return
    if (!current.deletedAt || current.transferState !== 'idle' || ['uploading','processing'].includes(current.processingStatus)) throw createError({statusCode:409,message:'照片正在处理或转移，暂不能彻底删除'})
    tx.update(tables.photos).set({processingStatus:'purging',updatedAt:new Date()}).where(eq(tables.photos.id,photo.id)).run()
  }, {behavior:'immediate'})
  // Failure keeps both the inventory and quota; the maintenance worker can retry.
  await purgeRegisteredPhoto(photo.id)
}

export async function cleanupExpiredTrashPhotos(retentionDays: number | null): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0
  const cutoff = new Date(Date.now()-retentionDays*86400000)
  const expired = useDB().select().from(tables.photos).where(and(isNotNull(tables.photos.deletedAt),lt(tables.photos.deletedAt,cutoff),eq(tables.photos.transferState,'idle'),notInArray(tables.photos.processingStatus,['uploading','processing']))).limit(100).all()
  let count=0
  for (const photo of expired) {
    try { await permanentlyDeletePhoto(photo); count++ }
    catch (error) { logger.image.error(`Failed to purge photo ${photo.id}`,error) }
  }
  return count
}
