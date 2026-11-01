import { readUser, userDto } from '../../../../services/users'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import { deletionDto } from '../../../../services/users/deletion'
import { storageUsageSnapshot } from '../../../../services/users/storage'
export default defineEventHandler(async (event) => {
  await requireAccess(event, 'admin')
  const user = readUser(Number(getRouterParam(event, 'id')))
  const usage = useDB().select().from(tables.userStorageUsage).where(eq(tables.userStorageUsage.userId, user.id)).get()
  const stats = useDB().select({ total: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(original_bytes),0)`, public: sql<number>`coalesce(sum(visibility='public'),0)`, private: sql<number>`coalesce(sum(visibility='private'),0)`, shared: sql<number>`coalesce(sum(visibility='shared'),0)`, processing: sql<number>`coalesce(sum(processing_status IN ('uploading','processing')),0)`, failed: sql<number>`coalesce(sum(processing_status='failed'),0)`, trash: sql<number>`coalesce(sum(deleted_at IS NOT NULL),0)`, blocked: sql<number>`coalesce(sum(moderation_status='blocked'),0)` }).from(tables.photos).where(eq(tables.photos.ownerId, user.id)).get()
  const recentActions = useDB().select().from(tables.auditLogs).where(or(eq(tables.auditLogs.ownerUserId, user.id), and(eq(tables.auditLogs.targetType, 'user'), eq(tables.auditLogs.targetId, String(user.id))))).orderBy(desc(tables.auditLogs.id)).limit(10).all()
  const transfers = useDB().select({ id: tables.photoOwnershipTransfers.id, state: tables.photoOwnershipTransfers.state, fromUserId: tables.photoOwnershipTransfers.fromUserId, toUserId: tables.photoOwnershipTransfers.toUserId, reservedBytes: tables.photoOwnershipTransfers.targetReservedBytes }).from(tables.photoOwnershipTransfers).where(and(or(eq(tables.photoOwnershipTransfers.fromUserId, user.id), eq(tables.photoOwnershipTransfers.toUserId, user.id)), sql`${tables.photoOwnershipTransfers.state} NOT IN ('completed','failed')`)).limit(20).all()
  const task = useDB().select({ id: tables.userDeletionTasks.id }).from(tables.userDeletionTasks).where(eq(tables.userDeletionTasks.userId, user.id)).orderBy(desc(tables.userDeletionTasks.createdAt)).get()
  return { ...userDto(user), usage, stats, recentActions, transfers, storageCheck: storageUsageSnapshot(user.id), deletionTask: task ? deletionDto(task.id) : null }
})
