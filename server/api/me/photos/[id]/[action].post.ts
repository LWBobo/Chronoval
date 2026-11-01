import { photoLifecycle } from '../../../../services/photo-management'
export default defineEventHandler(async(event)=>{
  const action=getRouterParam(event,'action')!
  if(!['trash','restore','purge','retry'].includes(action))throw createError({statusCode:404,message:'Action not found'})
  return photoLifecycle(await requireAccess(event,'user'),getRouterParam(event,'id')!,action as 'trash'|'restore'|'purge'|'retry')
})
