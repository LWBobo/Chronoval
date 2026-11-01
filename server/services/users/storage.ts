import { eq, sql } from 'drizzle-orm'
import type { Actor } from '../../utils/access'
import { tables, useDB } from '../../utils/db'
import { assertCurrentActor, audit } from './index'

/** File inventory remains billable until the complete photo purge commits. */
export function storageUsageSnapshot(userId: number, db = useDB()) {
  const recorded = db.select().from(tables.userStorageUsage).where(eq(tables.userStorageUsage.userId, userId)).get()
  if (!recorded) throw createError({ statusCode: 409, message: '空间账本缺失' })
  const used = db.select({ bytes: sql<number>`coalesce(sum(${tables.photoFiles.byteSize}),0)` }).from(tables.photoFiles)
    .innerJoin(tables.photos, eq(tables.photos.id, tables.photoFiles.photoId))
    .where(sql`${tables.photos.ownerId}=${userId} AND ${tables.photoFiles.isBillableOriginal}=1`).get()!.bytes
  const uploads = db.select({ bytes: sql<number>`coalesce(sum(${tables.uploadSessions.reservedBytes}),0)` }).from(tables.uploadSessions).where(eq(tables.uploadSessions.ownerUserId, userId)).get()!.bytes
  const transfers = db.select({ bytes: sql<number>`coalesce(sum(${tables.photoOwnershipTransfers.targetReservedBytes}),0)` }).from(tables.photoOwnershipTransfers).where(eq(tables.photoOwnershipTransfers.toUserId, userId)).get()!.bytes
  const computed = { usedBytes: used, reservedBytes: uploads + transfers }
  return { recorded: { usedBytes: recorded.usedBytes, reservedBytes: recorded.reservedBytes }, computed, consistent: recorded.usedBytes === computed.usedBytes && recorded.reservedBytes === computed.reservedBytes }
}

export function reconcileStorageUsage(actor: Actor, userId: number, input: { expectedVersion: number; reason: string }) {
  return useDB().transaction(tx => {
    assertCurrentActor(tx as any, actor, true)
    const user = tx.select().from(tables.users).where(eq(tables.users.id, userId)).get()
    if (!user || user.status === 'deleted') throw createError({ statusCode: 404, message: '用户不存在' })
    if (user.version !== input.expectedVersion) throw createError({ statusCode: 409, message: '用户资料已变化，请刷新' })
    const snapshot = storageUsageSnapshot(userId, tx as any)
    if (snapshot.consistent) return snapshot
    tx.update(tables.userStorageUsage).set({ ...snapshot.computed, updatedAt: new Date() }).where(eq(tables.userStorageUsage.userId, userId)).run()
    tx.update(tables.users).set({ version: user.version + 1, updatedAt: new Date() }).where(eq(tables.users.id, userId)).run()
    audit(tx as any, actor.user!.id, 'user.storage-reconcile', 'user', userId, { ownerId: userId, reason: input.reason, before: snapshot.recorded, after: snapshot.computed })
    return storageUsageSnapshot(userId, tx as any)
  }, { behavior: 'immediate' })
}
