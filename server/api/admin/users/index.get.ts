import { asc, and, eq, gt, inArray, like, or } from 'drizzle-orm'
import { z } from 'zod'
import { userDto } from '../../../services/users'
import { decodeListCursor, encodeListCursor, listFingerprint, listLimit } from '../../../utils/list-cursor'

export default defineEventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const q = getQuery(event)
  const term = `%${String(q.q ?? '').slice(0, 100).replace(/[%_]/g, '')}%`
  const limit = listLimit(q.limit)
  const status = q.status ? z.enum(['active', 'disabled', 'deleting', 'deleted']).parse(q.status) : null
  const role = q.role ? z.enum(['admin', 'user']).parse(q.role) : null
  const fingerprint = listFingerprint({ actor: actor.user!.id, term, status, role })
  const cursor = decodeListCursor(q.cursor, fingerprint)
  if (cursor && (!Number.isSafeInteger(cursor.id) || Number(cursor.id) < 1)) throw createError({ statusCode: 422, message: '无效分页位置' })
  const rows = useDB().select().from(tables.users).where(and(or(like(tables.users.username, term), like(tables.users.displayName, term), like(tables.users.email, term)), status ? eq(tables.users.status, status) : undefined, role ? eq(tables.users.role, role) : undefined, cursor ? gt(tables.users.id, Number(cursor.id)) : undefined)).orderBy(asc(tables.users.id)).limit(limit + 1).all()
  const page = rows.slice(0, limit)
  const usage = page.length ? useDB().select().from(tables.userStorageUsage).where(inArray(tables.userStorageUsage.userId, page.map(row => row.id))).all() : []
  const usageByUser = new Map(usage.map(row => [row.userId, row]))
  return { items: page.map(row => ({ ...userDto(row), usage: usageByUser.get(row.id) ?? { usedBytes: 0, reservedBytes: 0 } })), nextCursor: rows.length > limit ? encodeListCursor(fingerprint, { id: page.at(-1)!.id }) : null }
})
