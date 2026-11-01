import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { collectionAccessSchema, collectionAccessDto, collectionAudienceAccess, collectionAudienceSql, replaceCollectionPolicy } from '../../../../../services/collections/access'
import { photoVisibleSql, photoVisibilityClauses } from '../../../../../utils/photo-visibility'
import { toSessionUser } from '../../../../../utils/auth'
import { effectiveCollectionPassword } from '../../../../../utils/collection-password'

/** The simulation always rolls back its savepoint, including ACL versions and audit rows. */
export default defineEventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const id = Number(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, z.object({ access: collectionAccessSchema, userId: z.number().int().positive().nullable(), context: z.enum(['front', 'manage']).default('front') }).strict().parse)
  const user = body.userId ? useDB().select().from(tables.users).where(and(eq(tables.users.id, body.userId), eq(tables.users.status, 'active'))).get() : null
  if (body.userId && !user) throw createError({ statusCode: 422, message: '预览用户无效' })
  const simulated = { user: user ? toSessionUser(user) : null, isAdmin: user?.role === 'admin' }
  if (body.context === 'manage' && !simulated.isAdmin) throw createError({ statusCode: 422, message: '只有管理员身份可以预览管理上下文' })
  const rollback = { result: null as Record<string, unknown> | null }
  try {
    useDB().transaction(tx => {
      replaceCollectionPolicy(id, body.access, actor, tx as any)
      const collection = tx.select().from(tables.collections).where(eq(tables.collections.id, id)).get()!
      const membership = collection.kind === 'manual'
        ? sql`EXISTS(SELECT 1 FROM collection_photos cp WHERE cp.collection_id=${id} AND cp.photo_id=${tables.photos.id})`
        : collection.kind === 'person'
          ? sql`EXISTS(SELECT 1 FROM asset_faces af JOIN people p ON p.id=af.person_id WHERE p.collection_id=${id} AND af.photo_id=${tables.photos.id})`
          : sql`${tables.photos.libraryId}=${collection.libraryId} AND (${collection.relPath}='' OR substr(${tables.photos.libraryPath},1,length(${collection.relPath})+1)=${collection.relPath}||'/')`
      const candidates = tx.select({ id: tables.photos.id }).from(tables.photos).where(membership).limit(201).all()
      const ids = candidates.slice(0, 200).map(row => row.id)
      const options = { viewerRank: (simulated.isAdmin ? 2 : user ? 1 : 0) as 0|1|2, userId: user?.id ?? null, surface: 'discover' as const, unlockedIds: [], adminPasswordBypass: false }
      const allowed = ids.length ? tx.select({ id: tables.photos.id }).from(tables.photos).where(and(inArray(tables.photos.id, ids), body.context === 'manage' ? sql`1` : photoVisibleSql(options))).all() : []
      const clauses = photoVisibilityClauses(options)
      const otherAudience = sql`NOT EXISTS(SELECT 1 FROM collections c WHERE ${clauses.relevant} AND c.id!=${id} AND NOT ${collectionAudienceSql(sql`c.id`, options.userId, simulated.isAdmin)})`
      const blocks = ids.length && body.context !== 'manage' ? tx.select({ id: tables.photos.id, lifecycle: sql<number>`NOT (${clauses.lifecycle})`, photoAcl: sql<number>`NOT (${clauses.owner} OR ${clauses.photoAcl})`, collections: sql<number>`NOT (${clauses.owner} OR ${clauses.audience})`, otherCollections: sql<number>`NOT (${clauses.owner} OR ${otherAudience})`, passwords: sql<number>`NOT (${clauses.owner} OR ${clauses.passwordOk})` }).from(tables.photos).where(inArray(tables.photos.id,ids)).all() : []
      const counts = Object.fromEntries(['lifecycle','photoAcl','collections','otherCollections','passwords'].map(key => [key,blocks.filter(item => Number(item[key as keyof typeof item]) === 1).length]))
      rollback.result = { collectionId: id, canEnterAudience: collectionAudienceAccess(id, simulated, tx as any), passwordProtected: !!effectiveCollectionPassword(id), inheritedConstraints: collectionAccessDto(id, tx as any).inheritedConstraints, sampled: ids.length, hasMore: candidates.length > 200, visibleCount: allowed.length, blockedCount: ids.length - allowed.length, blockedPhotoIds: ids.filter(photoId => !allowed.some(row => row.id === photoId)).slice(0, 10), blockReasons: counts, blockedSamples: blocks.filter(item => !allowed.some(row => row.id === item.id)).slice(0,10), context: body.context }
      throw rollback
    }, { behavior: 'immediate' })
  } catch (error) { if (error !== rollback) throw error }
  return rollback.result
})
