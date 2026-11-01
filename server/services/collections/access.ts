import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { tables, useDB } from '../../utils/db'
import type { Actor } from '../../utils/access'
import { collectionAudienceAllows } from '../../utils/permission-policy'
import { audit, assertAdmin, assertCurrentActor, validateRecipients } from '../users'
import { hashAlbumPassword } from '../../utils/scanAlbumPassword'
import { collectionVisibilities } from '../../../shared/types/permissions'

export const collectionAccessSchema = z.object({
  expectedAclVersion: z.number().int().positive(),
  visibility: z.enum(collectionVisibilities),
  viewerIds: z.array(z.number().int().positive()).max(500),
  passwordAction: z.enum(['keep', 'set', 'clear']),
  newPassword: z.string().min(1).max(128).optional(),
  passwordExemptMode: z.enum(['none', 'logged_in', 'selected']),
  passwordExemptUserIds: z.array(z.number().int().positive()).max(500),
  reason: z.string().trim().min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  if ((value.passwordAction === 'set') !== (value.newPassword !== undefined)) ctx.addIssue({ code: 'custom', path: ['newPassword'], message: '仅设置密码时填写新密码' })
  if ((value.visibility === 'selected') !== (value.viewerIds.length > 0)) ctx.addIssue({ code: 'custom', path: ['viewerIds'], message: '指定用户可见须选择用户，其他模式须清空名单' })
  if ((value.passwordExemptMode === 'selected') !== (value.passwordExemptUserIds.length > 0)) ctx.addIssue({ code: 'custom', path: ['passwordExemptUserIds'], message: '免密指定名单与模式不匹配' })
  if (value.passwordAction === 'clear' && value.passwordExemptMode !== 'none') ctx.addIssue({ code: 'custom', path: ['passwordExemptMode'], message: '清除密码时同时关闭免密' })
})

export function collectionAudienceSql(id: SQL, userId: number | null, admin: boolean): SQL {
  return sql`EXISTS (SELECT 1 FROM collections ca WHERE ca.id=${id} AND ca.visibility IN ('public','login','selected','admin') AND (
    (ca.ownership_type='user' AND (${admin ? 1 : 0}=1 OR ca.owner_id=${userId ?? -1})) OR
    (ca.ownership_type='site' AND (${admin ? 1 : 0}=1 OR ca.visibility='public' OR (ca.visibility='login' AND ${userId ?? -1}>0) OR (ca.visibility='selected' AND EXISTS(SELECT 1 FROM collection_viewers cv WHERE cv.collection_id=ca.id AND cv.user_id=${userId ?? -1}))))
  ))`
}

export function folderRows(libraryId: number, relPath: string, db = useDB()) {
  return db.select().from(tables.collections).where(and(eq(tables.collections.kind, 'folder'), eq(tables.collections.libraryId, libraryId))).all().filter((row) => row.relPath === '' || row.relPath === relPath || relPath.startsWith(`${row.relPath}/`)).sort((a, b) => a.relPath.length - b.relPath.length)
}

export function collectionAudienceAccess(id: number, actor: Actor, db = useDB()): boolean {
  const row = db.select().from(tables.collections).where(eq(tables.collections.id, id)).get()
  if (!row) return false
  if (row.ownershipType === 'user') return actor.isAdmin || actor.user?.id === row.ownerId
  const rows = row.kind === 'folder' ? folderRows(row.libraryId!, row.relPath, db) : [row]
  return rows.length > 0 && rows.every((item) => {
    const viewer = actor.user ? !!db.select({ userId: tables.collectionViewers.userId }).from(tables.collectionViewers).where(and(eq(tables.collectionViewers.collectionId, item.id), eq(tables.collectionViewers.userId, actor.user.id))).get() : false
    return collectionAudienceAllows(actor, item.visibility, viewer)
  })
}

export function folderAudienceAccess(libraryId: number, relPath: string, actor: Actor): boolean {
  const rows = folderRows(libraryId, relPath)
  return rows.length > 0 && rows.every((row) => collectionAudienceAccess(row.id, actor))
}

export function collectionAccessDto(id: number, db = useDB()) {
  const row = db.select().from(tables.collections).where(eq(tables.collections.id, id)).get()
  if (!row) throw createError({ statusCode: 404, message: 'Collection not found' })
  const viewers = db.select({ id: tables.users.id, username: tables.users.username, displayName: tables.users.displayName, status: tables.users.status }).from(tables.collectionViewers).innerJoin(tables.users, eq(tables.collectionViewers.userId, tables.users.id)).where(eq(tables.collectionViewers.collectionId, id)).all()
  const exempt = db.select({ userId: tables.collectionPasswordExemptions.userId }).from(tables.collectionPasswordExemptions).where(eq(tables.collectionPasswordExemptions.collectionId, id)).all()
  return { collectionId: id, kind: row.kind, ownershipType: row.ownershipType, ownerId: row.ownerId, visibility: row.visibility, viewerIds: viewers.map((u) => u.id), viewers, passwordProtected: !!row.passwordHash, passwordExemptMode: row.passwordExemptMode, passwordExemptUserIds: exempt.map((u) => u.userId), aclVersion: row.aclVersion, passwordVersion: row.passwordVersion, inheritedConstraints: row.kind === 'folder' ? folderRows(row.libraryId!, row.relPath, db).filter((p) => p.id !== id).map((p) => ({ collectionId: p.id, path: p.relPath, visibility: p.visibility, aclVersion: p.aclVersion, passwordProtected: !!p.passwordHash })) : [], capabilities: { canEditAccess: row.ownershipType === 'site', reason: row.ownershipType === 'user' ? '个人分区，仅本人和管理员' : null } }
}

export function replaceCollectionPolicy(id: number, input: z.infer<typeof collectionAccessSchema>, actor: Actor, db = useDB()) {
  assertAdmin(actor)
  // Hashing is bounded and happens before acquiring the write transaction.
  const nextHash = input.passwordAction === 'set' ? hashAlbumPassword(input.newPassword!) : undefined
  return db.transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    const current = tx.select().from(tables.collections).where(eq(tables.collections.id, id)).get()
    if (!current) throw createError({ statusCode: 404, message: 'Collection not found' })
    if (current.ownershipType !== 'site') throw createError({ statusCode: 403, message: '个人分区不支持独立公开或共享' })
    if (current.aclVersion !== input.expectedAclVersion) throw createError({ statusCode: 409, message: '相册权限已被修改，请重新加载', data: { code: 'COLLECTION_ACCESS_CONFLICT', aclVersion: current.aclVersion } })
    const viewers = validateRecipients(tx as any, input.viewerIds, undefined, true)
    const exempt = validateRecipients(tx as any, input.passwordExemptUserIds, undefined, true)
    const hash = input.passwordAction === 'clear' ? null : nextHash ?? current.passwordHash
    if (!hash && input.passwordExemptMode !== 'none') throw createError({ statusCode: 422, message: '未设置密码时不能配置免密' })
    const before = collectionAccessDto(id, tx as any)
    tx.delete(tables.collectionViewers).where(eq(tables.collectionViewers.collectionId, id)).run()
    tx.delete(tables.collectionPasswordExemptions).where(eq(tables.collectionPasswordExemptions.collectionId, id)).run()
    if (viewers.length) tx.insert(tables.collectionViewers).values(viewers.map((userId) => ({ collectionId: id, userId, grantedBy: actor.user.id }))).run()
    if (exempt.length) tx.insert(tables.collectionPasswordExemptions).values(exempt.map((userId) => ({ collectionId: id, userId, grantedBy: actor.user.id }))).run()
    tx.update(tables.collections).set({ visibility: input.visibility, passwordHash: hash, passwordExemptMode: input.passwordExemptMode, aclVersion: current.aclVersion + 1, passwordVersion: current.passwordVersion + (input.passwordAction === 'keep' ? 0 : 1), updatedAt: new Date() }).where(eq(tables.collections.id, id)).run()
    const after = collectionAccessDto(id, tx as any)
    audit(tx as any, actor.user.id, 'collection.access', 'collection', id, { reason: input.reason, before, after })
    return after
  }, { behavior: 'immediate' })
}
