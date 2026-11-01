import { and, desc, eq, gte, lt } from 'drizzle-orm'
import { z } from 'zod'
import { decodeListCursor, encodeListCursor, listFingerprint, listLimit } from '../../utils/list-cursor'
export default defineEventHandler(async(event)=>{
  const actor = await requireAccess(event,'admin')
  const q = getQuery(event)
  const action = String(q.action ?? '').slice(0,100), actorId = q.actorId ? Number(q.actorId) : null
  if (actorId !== null && (!Number.isSafeInteger(actorId) || actorId < 1)) throw createError({statusCode:422,message:'无效用户'})
  const ownerId = q.ownerId ? z.coerce.number().int().positive().parse(q.ownerId) : null
  const targetType = q.targetType ? z.string().max(100).parse(q.targetType) : null
  const targetId = q.targetId ? z.string().max(256).parse(q.targetId) : null
  const from = q.from ? z.coerce.date().parse(q.from) : null
  const until = q.until ? z.coerce.date().parse(q.until) : null
  if (from && until && from >= until) throw createError({ statusCode: 422, message: '结束日期必须晚于开始日期' })
  const fingerprint = listFingerprint({actor:actor.user!.id,action,actorId,ownerId,targetType,targetId,from,until})
  const cursor = decodeListCursor(q.cursor,fingerprint), limit = listLimit(q.limit)
  if (cursor && (!Number.isSafeInteger(cursor.id) || Number(cursor.id) < 1)) throw createError({statusCode:422,message:'无效分页位置'})
  const rows = useDB().select().from(tables.auditLogs).where(and(action ? eq(tables.auditLogs.action,action) : undefined,actorId ? eq(tables.auditLogs.actorUserId,actorId) : undefined,ownerId ? eq(tables.auditLogs.ownerUserId,ownerId) : undefined,targetType ? eq(tables.auditLogs.targetType,targetType) : undefined,targetId ? eq(tables.auditLogs.targetId,targetId) : undefined,from ? gte(tables.auditLogs.createdAt,from) : undefined,until ? lt(tables.auditLogs.createdAt,until) : undefined,cursor ? lt(tables.auditLogs.id,Number(cursor.id)) : undefined)).orderBy(desc(tables.auditLogs.id)).limit(limit+1).all()
  const items = rows.slice(0,limit)
  return {items,nextCursor: rows.length>limit ? encodeListCursor(fingerprint,{id:items.at(-1)!.id}) : null}
})
