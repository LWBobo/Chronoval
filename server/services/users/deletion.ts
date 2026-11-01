import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { Actor } from '../../utils/access'
import { toSessionUser } from '../../utils/auth'
import { tables, useDB } from '../../utils/db'
import { randomId } from '../media-files/store'
import { assertCurrentActor, assertNotLastAdmin, audit } from './index'
import { cleanupUploadSession } from '../uploads/cleanup'
import { startOwnershipTransfer } from '../photo-management/transfer'

export function startUserDeletion(actor: Actor, userId: number, input: { expectedVersion: number; mode: 'transfer' | 'purge'; targetUserId?: number; idempotencyKey: string; reason: string }) {
  const digest = createHash('sha256').update(JSON.stringify({ userId, ...input })).digest('hex')
  return useDB().transaction(tx => {
    assertCurrentActor(tx as any, actor, true)
    const prior = tx.select().from(tables.userDeletionTasks).where(and(eq(tables.userDeletionTasks.actorUserId, actor.user!.id), eq(tables.userDeletionTasks.idempotencyKey, input.idempotencyKey))).get()
    if (prior) {
      if (prior.requestDigest !== digest) throw createError({ statusCode: 409, message: '操作编号已用于其他注销请求' })
      return deletionDto(prior.id, tx as any)
    }
    const user = tx.select().from(tables.users).where(eq(tables.users.id, userId)).get()
    if (!user || ['deleted', 'deleting'].includes(user.status)) throw createError({ statusCode: 409, message: '账号已注销或正在注销' })
    if (user.version !== input.expectedVersion) throw createError({ statusCode: 409, message: '账号已修改，请刷新' })
    assertNotLastAdmin(tx as any, user)
    if (input.mode === 'transfer') {
      const target = input.targetUserId ? tx.select().from(tables.users).where(eq(tables.users.id, input.targetUserId)).get() : null
      if (!target || target.status !== 'active' || target.id === userId) throw createError({ statusCode: 422, message: '请选择其他有效目标用户' })
      const sourceUsage = tx.select().from(tables.userStorageUsage).where(eq(tables.userStorageUsage.userId, userId)).get()!
      const targetUsage = tx.select().from(tables.userStorageUsage).where(eq(tables.userStorageUsage.userId, target.id)).get()!
      if (target.storageQuotaBytes !== null && targetUsage.usedBytes + targetUsage.reservedBytes + sourceUsage.usedBytes > target.storageQuotaBytes) throw createError({ statusCode: 409, message: '目标用户配额不足', data: { code: 'QUOTA_EXCEEDED' } })
    } else if (input.targetUserId !== undefined) throw createError({ statusCode: 422, message: '删除方式不接受转移目标' })
    const id = randomId()
    tx.insert(tables.userDeletionTasks).values({ id, userId, actorUserId: actor.user!.id, mode: input.mode, targetUserId: input.mode === 'transfer' ? input.targetUserId! : null, idempotencyKey: input.idempotencyKey, requestDigest: digest, reason: input.reason }).run()
    tx.update(tables.users).set({ status: 'deleting', authVersion: user.authVersion + 1, version: user.version + 1, disabledAt: new Date(), updatedAt: new Date() }).where(eq(tables.users.id, userId)).run()
    tx.insert(tables.pipelineQueue).values({ payload: { type: 'user-deletion', userId }, dedupeKey: `user-delete:${id}`, maxAttempts: 5 }).run()
    audit(tx as any, actor.user!.id, 'user.delete-start', 'user', userId, { reason: input.reason, after: { taskId: id, mode: input.mode, targetUserId: input.targetUserId } })
    return deletionDto(id, tx as any)
  }, { behavior: 'immediate' })
}

export function deletionDto(id: string, db = useDB()) {
  const row = db.select().from(tables.userDeletionTasks).where(eq(tables.userDeletionTasks.id, id)).get()
  if (!row) throw createError({ statusCode: 404, message: '注销任务不存在' })
  const remaining = db.select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${tables.photos.originalBytes}),0)` }).from(tables.photos).where(eq(tables.photos.ownerId, row.userId)).get()!
  const transfers = db.select({ id: tables.photoOwnershipTransfers.id, state: tables.photoOwnershipTransfers.state }).from(tables.photoOwnershipTransfers).where(and(or(eq(tables.photoOwnershipTransfers.fromUserId, row.userId), eq(tables.photoOwnershipTransfers.toUserId, row.userId)), sql`${tables.photoOwnershipTransfers.state} NOT IN ('completed','failed')`)).all()
  return { id: row.id, userId: row.userId, mode: row.mode, targetUserId: row.targetUserId, state: row.state, errorCode: row.errorCode, remainingPhotos: remaining.count, remainingBytes: remaining.bytes, transfers, completedAt: row.completedAt }
}

export function retryUserDeletion(actor: Actor, id: string, reason: string) {
  return useDB().transaction(tx => {
    assertCurrentActor(tx as any, actor, true)
    const task = tx.select().from(tables.userDeletionTasks).where(eq(tables.userDeletionTasks.id, id)).get()
    if (!task || task.state !== 'failed' || (task.leaseExpiresAt?.getTime() ?? 0) > Date.now()) throw createError({ statusCode: 409, message: '仅可重试已停止的失败任务' })
    tx.update(tables.userDeletionTasks).set({ state: 'pending', errorCode: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(tables.userDeletionTasks.id, id)).run()
    tx.insert(tables.pipelineQueue).values({ payload: { type: 'user-deletion', userId: task.userId }, dedupeKey: `user-delete:${id}`, maxAttempts: 5 }).onConflictDoNothing().run()
    audit(tx as any, actor.user!.id, 'user.delete-retry', 'user', task.userId, { reason })
    return deletionDto(id, tx as any)
  }, { behavior: 'immediate' })
}

/** One bounded batch per invocation. Pending file work releases the queue worker. */
export async function processUserDeletion(userId: number): Promise<boolean> {
  const db = useDB(), token = randomId()
  const task = db.transaction(tx => {
    const row = tx.select().from(tables.userDeletionTasks).where(and(eq(tables.userDeletionTasks.userId, userId), ne(tables.userDeletionTasks.state, 'completed'))).get()
    if (!row || row.state === 'failed') return null
    if (row.leaseToken && (row.leaseExpiresAt?.getTime() ?? 0) > Date.now()) return false
    tx.update(tables.userDeletionTasks).set({ state: 'running', leaseToken: token, leaseExpiresAt: new Date(Date.now() + 120000), updatedAt: new Date() }).where(eq(tables.userDeletionTasks.id, row.id)).run()
    return row
  }, { behavior: 'immediate' })
  if (task === false) return false
  if (!task) return true
  const taskId = task.id
  function fence() {
    const current = db.select().from(tables.userDeletionTasks).where(eq(tables.userDeletionTasks.id, taskId)).get()
    if (!current || current.leaseToken !== token) throw new Error('Deletion task lease lost')
    db.update(tables.userDeletionTasks).set({ leaseExpiresAt: new Date(Date.now() + 120000) }).where(eq(tables.userDeletionTasks.id, taskId)).run()
  }
  const heartbeat = setInterval(() => { try { fence() } catch {} }, 10000)
  heartbeat.unref()
  try {
    const owner = db.select().from(tables.users).where(eq(tables.users.id, userId)).get()
    if (owner?.status !== 'deleting') throw new Error('Deletion owner state changed')
    db.update(tables.uploadSessions).set({ state: 'cancelled', updatedAt: new Date() }).where(and(or(eq(tables.uploadSessions.ownerUserId, userId), eq(tables.uploadSessions.actorUserId, userId)), inArray(tables.uploadSessions.state, ['created', 'uploading', 'finalizing']))).run()
    const uploads = db.select({ id: tables.uploadSessions.id }).from(tables.uploadSessions).where(and(or(eq(tables.uploadSessions.ownerUserId, userId), eq(tables.uploadSessions.actorUserId, userId)), isNull(tables.uploadSessions.stagingCleanedAt))).limit(20).all()
    for (const upload of uploads) { fence(); await cleanupUploadSession(upload.id) }
    if (uploads.length) return false
    const photos = db.select().from(tables.photos).where(eq(tables.photos.ownerId, userId)).limit(10).all()
    for (const photo of photos) {
      fence()
      if (photo.transferState !== 'idle' || ['uploading', 'processing'].includes(photo.processingStatus)) continue
      if (task.mode === 'purge') {
        db.transaction(tx => {
          fence()
          tx.update(tables.photos).set({ deletedAt: photo.deletedAt ?? new Date(), processingStatus: 'purging', updatedAt: new Date() }).where(and(eq(tables.photos.id, photo.id), eq(tables.photos.ownerId, userId), eq(tables.photos.transferState, 'idle'))).run()
          tx.insert(tables.pipelineQueue).values({ payload: { type: 'photo-purge', photoId: photo.id }, photoId: photo.id, dedupeKey: `purge:${photo.id}` }).onConflictDoNothing().run()
        }, { behavior: 'immediate' })
      } else {
        const administrator = db.select().from(tables.users).where(eq(tables.users.id, task.actorUserId)).get()!
        const actor: Actor = { user: toSessionUser(administrator), isAdmin: true }
        const attempts = db.select({ count: sql<number>`count(*)` }).from(tables.photoOwnershipTransfers).where(eq(tables.photoOwnershipTransfers.photoIdSnapshot, photo.id)).get()!.count
        await startOwnershipTransfer(actor, photo.id, { toUserId: task.targetUserId!, expectedAclVersion: photo.aclVersion, idempotencyKey: `delete:${task.id}:${photo.id}:${attempts}`, reason: task.reason }, task.id)
      }
    }
    if (photos.length) return false
    const activeTransfer = db.select({ id: tables.photoOwnershipTransfers.id }).from(tables.photoOwnershipTransfers).where(and(or(eq(tables.photoOwnershipTransfers.fromUserId, userId), eq(tables.photoOwnershipTransfers.toUserId, userId)), sql`${tables.photoOwnershipTransfers.state} NOT IN ('completed','failed')`)).get()
    if (activeTransfer) return false
    db.transaction(tx => {
      fence()
      const usage = tx.select().from(tables.userStorageUsage).where(eq(tables.userStorageUsage.userId, userId)).get()!
      if (usage.usedBytes !== 0 || usage.reservedBytes !== 0 || tx.select({ id: tables.photos.id }).from(tables.photos).where(eq(tables.photos.ownerId, userId)).get()) throw new Error('Account storage cleanup is incomplete')
      const shared = tx.select({ id: tables.photoShares.photoId }).from(tables.photoShares).where(eq(tables.photoShares.recipientUserId, userId)).all()
      const viewers = tx.select({ id: tables.collectionViewers.collectionId }).from(tables.collectionViewers).where(eq(tables.collectionViewers.userId, userId)).all()
      const exemptions = tx.select({ id: tables.collectionPasswordExemptions.collectionId }).from(tables.collectionPasswordExemptions).where(eq(tables.collectionPasswordExemptions.userId, userId)).all()
      tx.delete(tables.photoShares).where(eq(tables.photoShares.recipientUserId, userId)).run()
      tx.delete(tables.collectionViewers).where(eq(tables.collectionViewers.userId, userId)).run()
      tx.delete(tables.collectionPasswordExemptions).where(eq(tables.collectionPasswordExemptions.userId, userId)).run()
      for (const photo of shared) tx.update(tables.photos).set({ aclVersion: sql`${tables.photos.aclVersion}+1`, updatedAt: new Date() }).where(eq(tables.photos.id, photo.id)).run()
      for (const id of new Set([...viewers, ...exemptions].map(row => row.id))) tx.update(tables.collections).set({ aclVersion: sql`${tables.collections.aclVersion}+1`, updatedAt: new Date() }).where(eq(tables.collections.id, id)).run()
      const personalCollections = tx.select({ id: tables.collections.id }).from(tables.collections).where(and(eq(tables.collections.ownershipType, 'user'), eq(tables.collections.ownerId, userId))).all()
      for (const collection of personalCollections) tx.delete(tables.collections).where(eq(tables.collections.id, collection.id)).run()
      let email: string
      do { email = `${userId}.${randomId()}@deleted.invalid` } while(tx.select({id:tables.users.id}).from(tables.users).where(eq(tables.users.emailKey,email)).get())
      tx.update(tables.users).set({ status: 'deleted', email, emailKey: email, displayName: 'Deleted user', avatar: null, password: null, totpSecret: null, totpEnabled: false, canUpload: false, deletedAt: new Date(), authVersion: sql`${tables.users.authVersion}+1`, version: sql`${tables.users.version}+1`, updatedAt: new Date() }).where(and(eq(tables.users.id, userId), eq(tables.users.status, 'deleting'))).run()
      tx.update(tables.userDeletionTasks).set({ state: 'completed', errorCode: null, completedAt: new Date(), updatedAt: new Date(), leaseToken: null, leaseExpiresAt: null }).where(eq(tables.userDeletionTasks.id, task.id)).run()
      audit(tx as any, task.actorUserId, 'user.delete-complete', 'user', userId, { reason: task.reason, after: { mode: task.mode, targetUserId: task.targetUserId } })
    }, { behavior: 'immediate' })
    return true
  } catch (error) {
    db.update(tables.userDeletionTasks).set({ state: 'failed', errorCode: 'ACCOUNT_CLEANUP_FAILED', updatedAt: new Date() }).where(and(eq(tables.userDeletionTasks.id, task.id), eq(tables.userDeletionTasks.leaseToken, token))).run()
    throw error
  } finally {
    clearInterval(heartbeat)
    db.update(tables.userDeletionTasks).set({ leaseToken: null, leaseExpiresAt: null }).where(and(eq(tables.userDeletionTasks.id, task.id), eq(tables.userDeletionTasks.leaseToken, token))).run()
  }
}
