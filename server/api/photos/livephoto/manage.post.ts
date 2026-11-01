import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { processSpecificLivePhotoVideo, siteLivePhotoIds } from '../../../services/video/scanner'
import { batchTestLivePhotoDetection } from '../../../services/video/test-utils'
import { assertCurrentActor, audit } from '../../../services/users'
import { tables, useDB } from '../../../utils/db'

export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(event, z.discriminatedUnion('action', [
    z.object({ action: z.literal('detect'), photoIds: z.array(z.string().min(1)).max(500).optional() }).strict(),
    z.object({ action: z.literal('scan'), photoIds: z.array(z.string().min(1)).max(500), reason: z.string().trim().min(1).max(1000) }).strict(),
    z.object({ action: z.enum(['process', 'update-photo']), photoId: z.string().min(1), expectedMetadataVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict(),
  ]).parse)
  if (body.action === 'detect') return batchTestLivePhotoDetection(body.photoIds)
  return useDB().transaction(db => {
    assertCurrentActor(db as any, actor, true)
    const ids = body.action === 'scan' ? siteLivePhotoIds(body.photoIds) : [body.photoId]
    if (body.action !== 'scan') {
      const photo = db.select().from(tables.photos).where(eq(tables.photos.id, body.photoId)).get()
      if (photo?.metadataVersion !== body.expectedMetadataVersion) throw createError({ statusCode: 409, message: '照片已变化，请刷新' })
    }
    const results = ids.map(photoId => {
      const success = processSpecificLivePhotoVideo(photoId)
      audit(db as any, actor.user!.id, 'photo.live-photo-refresh', 'photo', photoId, { reason: body.reason, after: { isLivePhoto: success } })
      return { photoId, success }
    })
    return { success: true, results }
  }, { behavior: 'immediate' })
})
