import { z } from 'zod'
import { startOwnershipTransfer } from '../../../../services/photo-management/transfer'
export default defineEventHandler(async(event)=>{
  const input=await readValidatedBody(event,z.object({toUserId:z.number().int().positive(),expectedAclVersion:z.number().int().positive(),idempotencyKey:z.string().min(8).max(128),reason:z.string().trim().min(1).max(1000)}).strict().parse)
  const result=await startOwnershipTransfer(await requireAccess(event,'admin'),getRouterParam(event,'id')!,input)
  setResponseStatus(event,202)
  return result
})
