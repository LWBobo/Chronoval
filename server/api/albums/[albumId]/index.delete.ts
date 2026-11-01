import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { mutateCollections } from '../../../services/collections/mutations'
import { tables } from '../../../utils/db'

export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const { albumId } = await getValidatedRouterParams(event, z.object({ albumId: z.coerce.number().int().positive() }).parse)
  const body = await readValidatedBody(event, z.object({ expectedAclVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict().parse)
  return mutateCollections(actor, [albumId], { [albumId]: body.expectedAclVersion }, body.reason, 'collection.delete', db => {
    const album = db.select().from(tables.collections).where(eq(tables.collections.id, albumId)).get()
    if (album?.kind !== 'manual') throw createError({ statusCode: 404, message: 'Album not found' })
    db.delete(tables.collections).where(eq(tables.collections.id, albumId)).run()
    return { success: true }
  })
})
