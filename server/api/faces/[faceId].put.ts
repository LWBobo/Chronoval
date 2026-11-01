import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createPerson, reassignFace } from '../../services/ml/person.service'
import { collectionVersionsSchema, mutateCollections, personCollectionIds, assertMembershipPhotos } from '../../services/collections/mutations'
import { audit } from '../../services/users'
export default eventHandler(async event => {
  const actor = await requireAccess(event, 'admin'), faceId = getRouterParam(event, 'faceId')!
  const body = await readValidatedBody(event, z.object({ personId: z.string().nullable().optional(), createPerson: z.boolean().optional(), name: z.string().trim().max(80).nullable().optional(), expectedMetadataVersion: z.number().int().positive(), versions: collectionVersionsSchema, reason: z.string().trim().min(1).max(1000) }).strict().parse)
  const face = useDB().select().from(tables.assetFaces).where(eq(tables.assetFaces.id, faceId)).get()
  if (!face) throw createError({ statusCode: 404, message: '人脸不存在' })
  const involved = [face.personId, body.personId].filter((id): id is string => !!id)
  return mutateCollections(actor, involved.length ? personCollectionIds(involved) : [], body.versions, body.reason, 'person.reassign', db => {
    assertMembershipPhotos([face.photoId], db)
    const photo = db.select().from(tables.photos).where(eq(tables.photos.id, face.photoId)).get()!
    const currentFace = db.select().from(tables.assetFaces).where(eq(tables.assetFaces.id, faceId)).get()
    if (photo.metadataVersion !== body.expectedMetadataVersion || currentFace?.personId !== face.personId) throw createError({ statusCode: 409, message: '照片或人脸关联已修改，请刷新' })
    let personId = body.personId ?? null
    if (body.createPerson) personId = createPerson(body.name, { origin: 'manual', ownershipType: photo.ownershipType, ownerId: photo.ownerId })!.id
    const result = reassignFace(faceId, personId)
    db.update(tables.photos).set({ metadataVersion: photo.metadataVersion + 1, updatedAt: new Date() }).where(eq(tables.photos.id, photo.id)).run()
    audit(db, actor.user!.id, 'face.reassign', 'photo', photo.id, { ownerId: photo.ownerId, reason: body.reason, before: { faceId, personId: face.personId }, after: { faceId, personId } })
    return { face: result, personId }
  })
})
