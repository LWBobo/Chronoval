import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Actor } from '../../utils/access'
import { tables, useDB } from '../../utils/db'
import { assertCurrentActor, audit } from '../users'

export const membershipFields = {
  photoIds: z.array(z.string().min(1).max(256)).min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
}
export const collectionVersionsSchema = z.record(z.string(), z.number().int().positive())

export function assertCollectionVersion(id: number, version: number | undefined, db = useDB()) {
  const row = db.select().from(tables.collections).where(eq(tables.collections.id, id)).get()
  if (!row) throw createError({ statusCode: 404, message: '相册不存在' })
  if (version !== row.aclVersion) throw createError({ statusCode: 409, message: '相册成员或权限已变化，请刷新后重试', data: { code: 'COLLECTION_ACCESS_CONFLICT', collectionId: id, aclVersion: row.aclVersion } })
  return row
}

export function assertMembershipPhotos(photoIds: string[], db = useDB()) {
  const ids = [...new Set(photoIds)]
  const rows = db.select().from(tables.photos).where(inArray(tables.photos.id, ids)).all()
  if (rows.length !== ids.length || rows.some(row => row.deletedAt || row.transferState !== 'idle' || row.processingStatus !== 'ready')) throw createError({ statusCode: 409, message: '照片不存在、位于回收站或正在处理，请刷新后重试' })
  const inactive = db.select({ id: tables.photos.id }).from(tables.photos).where(and(inArray(tables.photos.id, ids), sql`(EXISTS(SELECT 1 FROM users u WHERE u.id=${tables.photos.ownerId} AND u.status!='active') OR EXISTS(SELECT 1 FROM libraries l WHERE l.id=${tables.photos.libraryId} AND l.enabled=0))`)).get()
  if (inactive) throw createError({ statusCode: 409, message: '照片所属账号或扫描库已停用' })
}

/** Membership changes are permission changes: validate versions and audit atomically. */
export function mutateCollections<T>(actor: Actor, ids: number[], versions: Record<string, number>, reason: string, action: string, work: (db: ReturnType<typeof useDB>) => T): T {
  return useDB().transaction(tx => {
    assertCurrentActor(tx as any, actor, true)
    for (const id of new Set(ids)) assertCollectionVersion(id, versions[String(id)], tx as any)
    const result = work(tx as any)
    for (const id of new Set(ids)) audit(tx as any, actor.user!.id, action, 'collection', id, { reason })
    return result
  }, { behavior: 'immediate' })
}

export function personCollectionIds(personIds: string[], db = useDB()) {
  const ids = [...new Set(personIds)]
  const rows = db.select().from(tables.people).where(inArray(tables.people.id, ids)).all()
  if (rows.length !== ids.length || rows.some(row => row.collectionId === null)) throw createError({ statusCode: 404, message: '人物相册不存在' })
  return rows.map(row => row.collectionId!)
}
