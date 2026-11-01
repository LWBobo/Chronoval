import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { collectionAccessSchema, replaceCollectionPolicy } from '../../../../services/collections/access'
import { assertCurrentActor } from '../../../../services/users'
import { randomId } from '../../../../services/media-files/store'

export default defineEventHandler(async event => {
  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(event, z.object({
    operationId: z.string().min(8).max(128),
    items: z.array(z.object({ collectionId: z.number().int().positive(), access: collectionAccessSchema }).strict()).min(1).max(100),
  }).strict().refine(value => new Set(value.items.map(item => item.collectionId)).size === value.items.length, 'Duplicate collections').parse)
  const results = body.items.map(item => {
    try {
      const result = useDB().transaction(tx => {
        assertCurrentActor(tx as any, actor, true)
        const operationKey = `collection-access:${body.operationId}:${item.collectionId}`
        const digest = createHash('sha256').update(JSON.stringify(item)).digest('hex')
        const receipt = tx.select().from(tables.mutationReceipts).where(and(eq(tables.mutationReceipts.actorUserId, actor.user!.id), eq(tables.mutationReceipts.operationKey, operationKey))).get()
        if (receipt) {
          if (receipt.requestDigest !== digest) throw createError({ statusCode: 409, message: '操作编号已用于其他配置' })
          return receipt.resultJson
        }
        const dto = replaceCollectionPolicy(item.collectionId, item.access, actor, tx as any)
        tx.insert(tables.mutationReceipts).values({ id: randomId(), actorUserId: actor.user!.id, operationKey, requestDigest: digest, resultJson: dto }).run()
        return dto
      }, { behavior: 'immediate' })
      return { collectionId: item.collectionId, success: true, result }
    } catch (error: any) {
      return { collectionId: item.collectionId, success: false, statusCode: error.statusCode || 500, message: error.statusCode ? error.message : '相册权限保存失败' }
    }
  })
  return { results }
})
