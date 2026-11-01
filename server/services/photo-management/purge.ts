import { and, eq, sql } from 'drizzle-orm'
import { tables, useDB } from '../../utils/db'
import { FixedStore, claimKey } from '../media-files/store'
import { reconcilePeople } from '../ml/person.service'

const purges = new Map<string, Promise<void>>()

/** Queue workers and library cleanup share one operation until all I/O finishes. */
export function purgeRegisteredPhoto(photoId: string): Promise<void> {
  const current = purges.get(photoId)
  if (current) return current
  const work = purgePhoto(photoId).finally(() => purges.delete(photoId))
  purges.set(photoId, work)
  return work
}

async function purgePhoto(photoId:string) {
  const db=useDB(),photo=db.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
  if(!photo)return
  if(!photo.deletedAt||photo.transferState!=='idle'||photo.processingStatus!=='purging')throw new Error('Photo is not eligible for purge')
  const files=db.select().from(tables.photoFiles).where(eq(tables.photoFiles.photoId,photoId)).all()
  for(const file of files){
    if(file.state==='deleted')continue
    db.update(tables.photoFiles).set({state:'deleting'}).where(eq(tables.photoFiles.id,file.id)).run()
    // NAS originals are indexed, never deleted by gallery management.
    if(file.locatorType==='provider')await new FixedStore(file.storageProviderId!).remove(file.storageKey!)
    db.update(tables.photoFiles).set({state:'deleted'}).where(eq(tables.photoFiles.id,file.id)).run()
  }
  db.transaction((tx)=>{
    const current=tx.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
    if(!current)return
    if(current.transferState!=='idle'||current.processingStatus!=='purging')throw new Error('Photo changed during purge')
    const pending=tx.select({id:tables.photoFiles.id}).from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId,photoId),sql`${tables.photoFiles.state}!='deleted'`)).get()
    if(pending)throw new Error('Photo files still require cleanup')
    tx.delete(tables.photoFiles).where(and(eq(tables.photoFiles.photoId,photoId),eq(tables.photoFiles.locatorType,'embedded'))).run()
    tx.delete(tables.photoFiles).where(eq(tables.photoFiles.photoId,photoId)).run()
    tx.delete(tables.storagePathClaims).where(and(eq(tables.storagePathClaims.holderType,'file'),eq(tables.storagePathClaims.holderId,photoId))).run()
    if(current.ownerId&&current.originalBytes)tx.update(tables.userStorageUsage).set({usedBytes:sql`${tables.userStorageUsage.usedBytes}-${current.originalBytes}`,updatedAt:new Date()}).where(eq(tables.userStorageUsage.userId,current.ownerId)).run()
    const people=tx.select({id:tables.assetFaces.personId}).from(tables.assetFaces).where(eq(tables.assetFaces.photoId,photoId)).all()
    tx.run(sql`DELETE FROM photo_ocr_fts WHERE photo_id=${photoId}`)
    tx.delete(tables.photos).where(eq(tables.photos.id,photoId)).run()
    reconcilePeople(people.flatMap(person=>person.id?[person.id]:[]))
  },{behavior:'immediate'})
}
