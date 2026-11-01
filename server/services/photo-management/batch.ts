import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { tables, useDB } from '../../utils/db'
import type { Actor } from '../../utils/access'
import { assertCurrentActor } from '../users'
import { randomId } from '../media-files/store'
import { changePhotoVisibility, managedPhoto, photoLifecycle } from './index'

export const photoVisibilityBatchSchema = z.object({
  operationId: z.string().min(8).max(128),
  items: z.array(z.object({ id: z.string().min(1).max(256), expectedAclVersion: z.number().int().positive() }).strict()).min(1).max(100),
  visibility: z.enum(['private','public','shared']),
  recipientIds: z.array(z.number().int().positive()).max(500),
  reason: z.string().trim().max(1000).optional(),
}).strict().refine(input => new Set(input.items.map(item => item.id)).size === input.items.length, 'Duplicate photos')

/** All-or-nothing, including audit and idempotency receipt. */
export function changeVisibilityBatch(actor: Actor, input: z.infer<typeof photoVisibilityBatchSchema>) {
  const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return useDB().transaction(tx => {
    assertCurrentActor(tx as any,actor,actor.isAdmin)
    const operationKey=`photo-visibility:${input.operationId}`
    const previous=tx.select().from(tables.mutationReceipts).where(and(eq(tables.mutationReceipts.actorUserId,actor.user!.id),eq(tables.mutationReceipts.operationKey,operationKey))).get()
    if(previous){if(previous.requestDigest!==digest)throw createError({statusCode:409,message:'操作编号已用于其他批量请求'});return previous.resultJson}
    // Resolve all resources first. A mixed unauthorized list changes nothing.
    for(const item of input.items)managedPhoto(actor,item.id,tx as any)
    const items=input.items.map(item=>({id:item.id,...changePhotoVisibility(actor,item.id,{expectedAclVersion:item.expectedAclVersion,visibility:input.visibility,recipientIds:input.recipientIds,reason:input.reason})}))
    const result={items}
    tx.insert(tables.mutationReceipts).values({id:randomId(),actorUserId:actor.user!.id,operationKey,requestDigest:digest,resultJson:result}).run()
    return result
  },{behavior:'immediate'})
}

export const photoLifecycleBatchSchema = z.object({
  operationId: z.string().min(8).max(128),
  action: z.enum(['trash', 'restore', 'purge']),
  items: z.array(z.object({ id: z.string().min(1).max(256), expectedVersion: z.number().int().positive() }).strict()).min(1).max(100),
  reason: z.string().trim().max(1000).optional(),
}).strict().refine(input => new Set(input.items.map(item => item.id)).size === input.items.length, 'Duplicate photos')

export function changeLifecycleBatch(actor: Actor, input: z.infer<typeof photoLifecycleBatchSchema>) {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return useDB().transaction(tx => {
    assertCurrentActor(tx as any, actor, actor.isAdmin)
    const operationKey = `photo-lifecycle:${input.operationId}`
    const previous = tx.select().from(tables.mutationReceipts).where(and(eq(tables.mutationReceipts.actorUserId, actor.user!.id), eq(tables.mutationReceipts.operationKey, operationKey))).get()
    if (previous) {
      if (previous.requestDigest !== digest) throw createError({ statusCode: 409, message: '操作编号已用于其他批量请求' })
      return previous.resultJson
    }
    for (const item of input.items) {
      const photo = managedPhoto(actor, item.id, tx as any)
      if (photo.metadataVersion !== item.expectedVersion) throw createError({ statusCode: 409, message: '照片已变化，请刷新后重试' })
      if (actor.isAdmin && photo.ownerId !== null && photo.ownerId !== actor.user!.id && !input.reason?.trim()) throw createError({ statusCode: 422, message: '管理员批量操作他人照片须填写原因' })
    }
    const result = { items: input.items.map(item => ({ id: item.id, ...photoLifecycle(actor, item.id, input.action, input.reason) })) }
    tx.insert(tables.mutationReceipts).values({ id: randomId(), actorUserId: actor.user!.id, operationKey, requestDigest: digest, resultJson: result }).run()
    return result
  }, { behavior: 'immediate' })
}
