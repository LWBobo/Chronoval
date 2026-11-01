import { and, eq, lt, sql } from 'drizzle-orm'
import { tables, useDB } from '../../utils/db'

/** Restore durable cleanup work after queue exhaustion or a process restart. */
export function recoverManagedWork() {
  const db = useDB(), now = new Date(), stale = new Date(Date.now() - 60000)
  db.delete(tables.authChallengeUses).where(lt(tables.authChallengeUses.expiresAt, now)).run()
  // A crashed scan or a manually removed processing task must not freeze an
  // asset forever. Live queue work remains authoritative and is never reset.
  db.update(tables.photos).set({processingStatus:'failed',processingErrorCode:'PROCESSING_INTERRUPTED',updatedAt:now}).where(and(eq(tables.photos.processingStatus,'processing'),eq(tables.photos.transferState,'idle'),lt(tables.photos.updatedAt,new Date(Date.now()-30*60000)),sql`NOT EXISTS(SELECT 1 FROM pipeline_queue q WHERE (q.photo_id=${tables.photos.id} OR json_extract(q.payload,'$.photoId')=${tables.photos.id}) AND q.status IN ('pending','in-stages'))`)).run()
  const transfers = db.select().from(tables.photoOwnershipTransfers).where(and(sql`${tables.photoOwnershipTransfers.state} NOT IN ('completed','failed')`, sql`(${tables.photoOwnershipTransfers.leaseExpiresAt} IS NULL OR ${tables.photoOwnershipTransfers.leaseExpiresAt}<${Math.floor(Date.now()/1000)})`, lt(tables.photoOwnershipTransfers.updatedAt, stale))).limit(100).all()
  for (const task of transfers) db.insert(tables.pipelineQueue).values({ payload: { type: task.cutoverAt ? 'ownership-transfer-cleanup' : 'ownership-transfer', transferId: task.id }, photoId: task.photoId, dedupeKey: `transfer:${task.id}`, maxAttempts: 5, priority: -1 }).onConflictDoNothing().run()
  const purging = db.select({ id: tables.photos.id }).from(tables.photos).where(and(eq(tables.photos.processingStatus, 'purging'), eq(tables.photos.transferState, 'idle'))).limit(100).all()
  for (const photo of purging) db.insert(tables.pipelineQueue).values({ payload: { type: 'photo-purge', photoId: photo.id }, photoId: photo.id, dedupeKey: `purge:${photo.id}`, priority: -1 }).onConflictDoNothing().run()
  const deletions = db.select().from(tables.userDeletionTasks).where(and(sql`${tables.userDeletionTasks.state} IN ('pending','running')`, sql`(${tables.userDeletionTasks.leaseExpiresAt} IS NULL OR ${tables.userDeletionTasks.leaseExpiresAt}<${Math.floor(Date.now()/1000)})`, lt(tables.userDeletionTasks.updatedAt, stale))).limit(100).all()
  for (const task of deletions) db.insert(tables.pipelineQueue).values({ payload: { type: 'user-deletion', userId: task.userId }, dedupeKey: `user-delete:${task.id}`, maxAttempts: 5, priority: -2 }).onConflictDoNothing().run()
}
