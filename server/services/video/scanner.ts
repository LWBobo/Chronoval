import { and, eq, isNull } from 'drizzle-orm'
import { tables, useDB } from '../../utils/db'
import { registeredFile } from '../media-files/read'

/** Pairing happens during controlled upload/library scan. Repair only registered site assets. */
export function processSpecificLivePhotoVideo(photoId: string): boolean {
  return useDB().transaction(db => {
    const photo = db.select().from(tables.photos).where(eq(tables.photos.id, photoId)).get()
    if (!photo || photo.ownershipType !== 'site' || photo.deletedAt || photo.transferState !== 'idle' || photo.processingStatus !== 'ready') throw createError({ statusCode: 409, message: '站点照片不可处理' })
    if (photo.libraryId) {
      const library = db.select().from(tables.libraries).where(eq(tables.libraries.id, photo.libraryId)).get()
      if (!library?.enabled || library.deleting) throw createError({ statusCode: 409, message: '扫描库不可用' })
    }
    const original = registeredFile(photoId, 'original'), live = registeredFile(photoId, 'live_video')
    const found = !!original && !!live && (live.locatorType !== 'embedded' || live.parentFileId === original.id)
    if (photo.isLivePhoto !== Number(found)) db.update(tables.photos).set({ isLivePhoto: Number(found), metadataVersion: photo.metadataVersion + 1, updatedAt: new Date() }).where(eq(tables.photos.id, photoId)).run()
    return found
  }, { behavior: 'immediate' })
}

export function siteLivePhotoIds(ids?: string[]) {
  const photos = useDB().select({ id: tables.photos.id }).from(tables.photos).where(and(eq(tables.photos.ownershipType, 'site'), eq(tables.photos.processingStatus, 'ready'), eq(tables.photos.transferState, 'idle'), isNull(tables.photos.deletedAt))).all()
  const requested = ids ? new Set(ids) : null
  return photos.map(photo => photo.id).filter(id => !requested || requested.has(id))
}
