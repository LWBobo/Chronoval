import { findRecipients } from '../../services/users'
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm'
import { assertRateLimit } from '../../utils/rate-limit'
export default defineEventHandler(async (event) => {
  const actor = await requireAccess(event, 'user')
  const query = getQuery(event)
  const includeAdmin = query.includeAdmin === '1'
  const search = String(query.q ?? '').trim().toLowerCase().slice(0, 100)
  assertRateLimit(event, { namespace: 'recipient-search', subject: String(actor.user!.id), limit: 120, windowMs: 60000 })
  assertRateLimit(event, { namespace: 'recipient-search-ip', limit: 300, windowMs: 60000 })
  const ids = String(query.ids ?? '').split(',').filter(Boolean).map(Number)
  if (ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw createError({ statusCode: 422, message: '无效用户列表' })
  const fields = { id: tables.users.id, username: tables.users.username, displayName: tables.users.displayName, status: tables.users.status }
  // A caller may resolve their existing recipients, but arbitrary IDs must not
  // turn the picker into an account directory for ordinary users.
  const selected = ids.length ? useDB().select(fields).from(tables.users).where(and(inArray(tables.users.id, ids), includeAdmin ? undefined : eq(tables.users.role, 'user'), actor.isAdmin ? undefined : sql`EXISTS(SELECT 1 FROM photo_shares s JOIN photos p ON p.id=s.photo_id WHERE s.recipient_user_id=${tables.users.id} AND p.owner_id=${actor.user!.id})`)).all() : []
  let matches: typeof selected = []
  if (actor.isAdmin) matches = findRecipients(search, includeAdmin, query.includeInactive === '1')
  else if (search.length >= 3) {
    matches = useDB().select(fields).from(tables.users).where(and(eq(tables.users.status, 'active'), includeAdmin ? undefined : eq(tables.users.role, 'user'), or(eq(tables.users.emailKey, search), and(gte(tables.users.username, search), lt(tables.users.username, `${search}\uffff`))))).limit(20).all()
  }
  return [...new Map([...selected, ...matches].map(row => [row.id, row])).values()]
})
