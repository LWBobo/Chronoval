import { and, eq } from 'drizzle-orm'
import { tables, useDB } from '../../utils/db'
import { FixedStore } from '../media-files/store'

/** Recover unfinished derivatives without touching any original or quota entry. */
export async function discardFailedDerivatives(photoId: string) {
  const db = useDB()
  const files = db.transaction(tx => {
    const photo = tx.select().from(tables.photos).where(eq(tables.photos.id, photoId)).get()
    if (!photo || photo.processingStatus !== 'failed' || photo.transferState !== 'idle') throw createError({ statusCode: 409, message: '照片状态已变化' })
    const pending = tx.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, photoId), eq(tables.photoFiles.state, 'staging'))).all()
    if (pending.some(file => file.isBillableOriginal || !['preview','thumbnail','poster','sanitized_download'].includes(file.role) || file.locatorType !== 'provider')) throw createError({ statusCode: 409, message: '原件登记需要管理员检查' })
    if (pending.length) tx.update(tables.photos).set({ processingStatus: 'processing', processingErrorCode: 'DERIVATIVE_CLEANUP', updatedAt: new Date() }).where(eq(tables.photos.id, photoId)).run()
    return pending
  }, { behavior: 'immediate' })
  if (!files.length) return
  try {
    for (const file of files) {
      const store = new FixedStore(file.storageProviderId!), meta = await store.meta(file.storageKey!)
      if (meta) {
        if (meta.size !== file.byteSize || !file.checksumSha256 || await store.checksum(file.storageKey!) !== file.checksumSha256) throw new Error('Unfinished derivative requires administrator review')
        await store.remove(file.storageKey!)
      }
      db.delete(tables.photoFiles).where(and(eq(tables.photoFiles.id, file.id), eq(tables.photoFiles.state, 'staging'))).run()
    }
  } finally {
    db.update(tables.photos).set({ processingStatus: 'failed', processingErrorCode: 'MEDIA_PROCESSING_FAILED', updatedAt: new Date() }).where(and(eq(tables.photos.id, photoId), eq(tables.photos.processingErrorCode, 'DERIVATIVE_CLEANUP'))).run()
  }
}
