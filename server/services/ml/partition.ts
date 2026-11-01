import { and, eq, isNull, sql } from 'drizzle-orm'
import { tables, useDB } from '../../utils/db'

export type PhotoPartition = { ownershipType: 'site'|'user'; ownerId: number|null }
export function samePhotoPartition(a: PhotoPartition, b: PhotoPartition) { return a.ownershipType===b.ownershipType && a.ownerId===b.ownerId }
export function eligibleMlPhotoSql() {
  return and(isNull(tables.photos.deletedAt),eq(tables.photos.transferState,'idle'),eq(tables.photos.processingStatus,'ready'),sql`(${tables.photos.ownerId} IS NULL OR EXISTS(SELECT 1 FROM users mu WHERE mu.id=${tables.photos.ownerId} AND mu.status='active'))`)!
}
export function currentMlPhoto(id: string) { return useDB().select().from(tables.photos).where(and(eq(tables.photos.id,id),eligibleMlPhotoSql())).get() }
export function mlSnapshotCurrent(id: string, snapshot: PhotoPartition & { checksum: string|null; originalVersion: number }) {
  const current=currentMlPhoto(id)
  if(!current||!samePhotoPartition(current,snapshot)||current.contentChecksum!==snapshot.checksum)return false
  const original=useDB().select({version:tables.photoFiles.contentVersion}).from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId,id),eq(tables.photoFiles.role,'original'),eq(tables.photoFiles.state,'ready'))).get()
  return original?.version===snapshot.originalVersion
}
export function assertPersonPhotoPartition(person: PhotoPartition, photoId: string) {
  const photo=currentMlPhoto(photoId)
  if(!photo||!samePhotoPartition(person,photo))throw createError({statusCode:409,message:'照片与人物必须属于同一所有者分区，且当前可操作'})
  return photo
}
