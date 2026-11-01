import { and, desc, eq, gte, isNotNull, isNull, like, lt, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { tables, useDB } from '../../utils/db'
import type { Actor } from '../../utils/access'
import type { PhotoAccessContext } from '../../utils/photo-access'
import { visiblePhotoSql } from '../../utils/photo-access'
import { decodeListCursor, encodeListCursor, listFingerprint, listLimit } from '../../utils/list-cursor'
import { toPublicPhoto } from '../../utils/photo-dto'
import { withAssetUrls, withAssetUrlsBatch } from '../media-files'
import { assertAdmin } from '../users'

export function managedPhotoDto(photo: typeof tables.photos.$inferSelect, actor: Actor, resolved?: ReturnType<typeof withAssetUrls>) {
  const canManage = actor.isAdmin || photo.ownerId === actor.user?.id
  const mutable = canManage && photo.transferState !== 'moving' && photo.processingStatus !== 'purging'
  return {
    ...toPublicPhoto(resolved ?? withAssetUrls(photo, canManage), canManage),
    ...(canManage ? { ownerId: photo.ownerId, ownershipType: photo.ownershipType, originalFilename: photo.originalFilename, uploadRelativePath: photo.uploadRelativePath, visibility: photo.visibility, aclVersion: photo.aclVersion, metadataVersion: photo.metadataVersion, processingStatus: photo.processingStatus, processingErrorCode: photo.processingErrorCode, transferState: photo.transferState, activeTransferId: photo.activeTransferId, moderationStatus: photo.moderationStatus, moderationReason: photo.moderationReason, deletedAt: photo.deletedAt, originalBytes: photo.originalBytes } : {}),
    capabilities: { canManage: mutable, canChangeVisibility: mutable && photo.ownershipType === 'user' && photo.transferState === 'idle', canTransfer: actor.isAdmin && photo.ownershipType === 'user' && photo.transferState === 'idle' && ['ready', 'failed'].includes(photo.processingStatus), canPurge: mutable && !!photo.deletedAt && photo.transferState === 'idle' && !['uploading', 'processing'].includes(photo.processingStatus) },
  }
}

export function listManagedPhotos(actor: Actor, query: Record<string, unknown>, context: PhotoAccessContext, admin = false) {
  if (admin) assertAdmin(actor)
  const mode = z.enum(['mine', 'trash', 'shared-with-me', 'shared-by-me']).parse(query.mode ?? 'mine')
  const limit = listLimit(query.limit)
  const search = String(query.q ?? '').trim().slice(0, 100)
  const ownerId = query.ownerId === undefined ? null : z.coerce.number().int().positive().parse(query.ownerId)
  if (!admin && ownerId !== null) throw createError({ statusCode: 422, message: '个人列表不接受其他所有者' })
  const state = query.state ? z.enum(['uploading', 'processing', 'ready', 'failed', 'purging']).parse(query.state) : null
  const ownership = query.ownershipType ? z.enum(['site', 'user']).parse(query.ownershipType) : null
  const visibility = query.visibility ? z.enum(['private', 'public', 'shared', 'inherit']).parse(query.visibility) : null
  const source = query.source ? z.enum(['upload', 'library']).parse(query.source) : null
  const moderation = query.moderationStatus ? z.enum(['visible', 'blocked']).parse(query.moderationStatus) : null
  const uploadedBy = query.uploadedBy ? z.coerce.number().int().positive().parse(query.uploadedBy) : null
  const recipientId = query.recipientId ? z.coerce.number().int().positive().parse(query.recipientId) : null
  const from = query.from ? z.coerce.date().parse(query.from) : null
  const until = query.until ? z.coerce.date().parse(query.until) : null
  if (from && until && from >= until) throw createError({ statusCode: 422, message: '结束日期必须晚于开始日期' })
  const fingerprint = listFingerprint({ actor: actor.user!.id, mode, admin, search, ownerId, state, ownership, visibility, source, moderation, uploadedBy, recipientId, from, until })
  const cursor = decodeListCursor(query.cursor, fingerprint)
  if (cursor && (!Number.isSafeInteger(cursor.createdAt) || typeof cursor.id !== 'string' || cursor.id.length > 256)) throw createError({ statusCode: 422, message: '无效分页位置' })
  const conditions = [mode === 'trash' ? isNotNull(tables.photos.deletedAt) : isNull(tables.photos.deletedAt)]
  if (!admin) {
    if (mode === 'shared-with-me') conditions.push(and(ne(tables.photos.ownerId, actor.user!.id), eq(tables.photos.visibility, 'shared'), sql`EXISTS(SELECT 1 FROM photo_shares s WHERE s.photo_id=${tables.photos.id} AND s.recipient_user_id=${actor.user!.id})`, visiblePhotoSql(context))!)
    else conditions.push(eq(tables.photos.ownerId, actor.user!.id))
  } else if (ownerId !== null) conditions.push(eq(tables.photos.ownerId, ownerId))
  if (mode === 'shared-by-me') conditions.push(eq(tables.photos.visibility, 'shared'))
  if (state) conditions.push(eq(tables.photos.processingStatus, state))
  if (ownership) conditions.push(eq(tables.photos.ownershipType, ownership))
  if (visibility) conditions.push(eq(tables.photos.visibility, visibility))
  if (source) conditions.push(eq(tables.photos.source, source))
  if (moderation) conditions.push(eq(tables.photos.moderationStatus, moderation))
  if (uploadedBy) conditions.push(eq(tables.photos.uploadedBy, uploadedBy))
  if (recipientId) conditions.push(sql`EXISTS(SELECT 1 FROM photo_shares s WHERE s.photo_id=${tables.photos.id} AND s.recipient_user_id=${recipientId})`)
  if (from) conditions.push(gte(tables.photos.createdAt, from))
  if (until) conditions.push(lt(tables.photos.createdAt, until))
  if (search) conditions.push(or(like(tables.photos.title, `%${search.replace(/[%_]/g, '')}%`), like(tables.photos.originalFilename, `%${search.replace(/[%_]/g, '')}%`))!)
  if (cursor) conditions.push(or(sql`${tables.photos.createdAt}<${Math.floor(Number(cursor.createdAt) / 1000)}`, and(eq(tables.photos.createdAt, new Date(Number(cursor.createdAt))), sql`${tables.photos.id}<${cursor.id}`))!)
  const rows = useDB().select().from(tables.photos).where(and(...conditions)).orderBy(desc(tables.photos.createdAt), desc(tables.photos.id)).limit(limit + 1).all()
  const page = rows.slice(0, limit)
  const urls = withAssetUrlsBatch(page, row => actor.isAdmin || row.ownerId === actor.user!.id)
  const ownerIds = new Set(page.map(row => row.ownerId).filter((id): id is number => id !== null))
  const owners = admin && ownerIds.size ? useDB().select({ id: tables.users.id, username: tables.users.username, displayName: tables.users.displayName, status: tables.users.status }).from(tables.users).where(sql`${tables.users.id} IN (${sql.join([...ownerIds].map(id => sql`${id}`), sql`,`)})`).all() : []
  const uploaders = admin && page.some(row => row.uploadedBy !== null) ? useDB().select({ id: tables.users.id, username: tables.users.username, displayName: tables.users.displayName }).from(tables.users).where(sql`${tables.users.id} IN (${sql.join([...new Set(page.flatMap(row => row.uploadedBy === null ? [] : [row.uploadedBy]))].map(id => sql`${id}`), sql`,`)})`).all() : []
  const shareCounts = page.length ? useDB().select({ photoId: tables.photoShares.photoId, count: sql<number>`count(*)` }).from(tables.photoShares).where(sql`${tables.photoShares.photoId} IN (${sql.join(page.map(row => sql`${row.id}`), sql`,`)})`).groupBy(tables.photoShares.photoId).all() : []
  const last = page.at(-1)
  return { items: page.map((row, index) => ({ ...managedPhotoDto(row, actor, urls[index]), ...(admin || row.ownerId === actor.user!.id ? { shareCount: shareCounts.find(item => item.photoId === row.id)?.count ?? 0 } : {}), ...(admin ? { owner: owners.find(owner => owner.id === row.ownerId) ?? null, uploader: uploaders.find(user => user.id === row.uploadedBy) ?? null } : {}) })), nextCursor: rows.length > limit && last ? encodeListCursor(fingerprint, { createdAt: last.createdAt.getTime(), id: last.id }) : null }
}
