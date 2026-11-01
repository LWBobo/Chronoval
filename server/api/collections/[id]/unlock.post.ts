import { z } from 'zod'
import { collectionAudienceAccess } from '../../../services/collections/access'
import { effectiveCollectionPassword, authorizeCollection } from '../../../utils/collection-password'
import { verifyAlbumPassword } from '../../../utils/scanAlbumPassword'
export default defineEventHandler(async (event) => {
  const actor = await getActor(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!collectionAudienceAccess(id, actor)) throw createError({ statusCode: 404, message: 'Collection not found' })
  const { password } = await readValidatedBody(event, z.object({ password: z.string().max(128) }).strict().parse)
  assertRateLimit(event, { namespace: 'collection-unlock', subject: String(id), limit: 10, windowMs: 15 * 60 * 1000 })
  const origin = effectiveCollectionPassword(id)
  if (origin && !(await verifyAlbumPassword(origin.passwordHash!, password))) throw createError({ statusCode: 401, message: '相册密码不正确' })
  await authorizeCollection(event, id)
  return { authorized: true }
})
