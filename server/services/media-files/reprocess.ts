import { and, eq } from 'drizzle-orm'
import { tables, useDB } from '../../utils/db'
import { processUploadedPhoto } from '../uploads/process'
import { sanitizePhotoLocation } from './sanitize'

export async function reprocessRegisteredPhoto(photoId: string, stripLocation = false) {
  const db=useDB()
  const photo=db.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
  if(!photo || photo.deletedAt || photo.transferState!=='idle' || !['ready','failed'].includes(photo.processingStatus))throw new Error('Photo is busy or unavailable')
  if(photo.ownerId){const user=db.select().from(tables.users).where(eq(tables.users.id,photo.ownerId)).get();if(user?.status!=='active')throw new Error('Owner inactive')}
  if(photo.source==='library'){
    const {libraryScanner}=await import('../library/scanner')
    await libraryScanner.reindexFile(photo.libraryMount!,photo.libraryPath!)
    // The scanner already recreates safe copies for stripLocation photos.
    if(stripLocation&&!photo.stripLocation)await sanitizePhotoLocation(photoId)
    return
  }
  const changed=db.update(tables.photos).set({processingStatus:'processing',processingErrorCode:null,stripLocation:stripLocation||photo.stripLocation,updatedAt:new Date()}).where(and(eq(tables.photos.id,photoId),eq(tables.photos.transferState,'idle'),eq(tables.photos.metadataVersion,photo.metadataVersion))).run()
  if(!changed.changes)throw new Error('Photo changed')
  await processUploadedPhoto(photoId)
}
