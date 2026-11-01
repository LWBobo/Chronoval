import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'

/** Restore unfinished tasks after a refresh without persisting file bytes in the browser. */
export default defineEventHandler(async event => {
  const actor = await requireAccess(event, 'user')
  const query = getQuery(event)
  const ownerId = actor.isAdmin && query.ownerUserId !== undefined
    ? query.ownerUserId === 'site' ? null : z.coerce.number().int().positive().parse(query.ownerUserId)
    : actor.user!.id
  const rows = useDB().select({ id: tables.uploadSessions.id, photoId: tables.uploadSessions.photoId, state: tables.uploadSessions.state, expiresAt: tables.uploadSessions.expiresAt, taskId: tables.uploadSessions.commitTaskId, status: tables.photos.processingStatus, errorCode: tables.photos.processingErrorCode }).from(tables.uploadSessions)
    .leftJoin(tables.photos, eq(tables.photos.id, tables.uploadSessions.photoId))
    .where(and(eq(tables.uploadSessions.actorUserId, actor.user!.id), ownerId === null ? isNull(tables.uploadSessions.ownerUserId) : eq(tables.uploadSessions.ownerUserId, ownerId), sql`${tables.photos.ownerId} IS ${tables.uploadSessions.ownerUserId}`, or(inArray(tables.uploadSessions.state, ['created', 'uploading', 'finalizing']), and(eq(tables.uploadSessions.state, 'committed'), inArray(tables.photos.processingStatus, ['processing', 'failed'])))))
    .orderBy(desc(tables.uploadSessions.createdAt), desc(tables.uploadSessions.id)).limit(50).all()
  const parts = rows.length ? useDB().select({ sessionId: tables.uploadParts.sessionId, id: tables.uploadParts.id, role: tables.uploadParts.role, state: tables.uploadParts.state, size: tables.uploadParts.expectedBytes, filename: tables.uploadParts.originalFilename }).from(tables.uploadParts).where(inArray(tables.uploadParts.sessionId, rows.map(row => row.id))).all() : []
  return { items: rows.map(row => ({ id: row.id, photoId: row.photoId, state: row.state, expiresAt: row.expiresAt, taskId: row.taskId, photo: row.status ? { status: row.status, errorCode: row.errorCode } : null, parts: parts.filter(part => part.sessionId === row.id).map(({ sessionId: _sessionId, ...part }) => part) })) }
})
