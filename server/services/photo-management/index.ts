import { and, eq, sql } from 'drizzle-orm'
import type { Actor } from '../../utils/access'
import { tables, useDB } from '../../utils/db'
import { assertCurrentActor, audit, validateRecipients } from '../users'

export function managedPhoto(actor:Actor,id:string,db=useDB()) {
  assertCurrentActor(db, actor, actor.isAdmin)
  const photo=db.select().from(tables.photos).where(eq(tables.photos.id,id)).get()
  if(!photo||!actor.user||(!actor.isAdmin&&(photo.ownershipType!=='user'||photo.ownerId!==actor.user.id)))throw createError({statusCode:404,message:'Photo not found'})
  if(photo.transferState==='moving'||photo.processingStatus==='purging')throw createError({statusCode:409,message:'照片正在转移或清理，请稍后操作'})
  return photo
}

export function changePhotoVisibility(actor:Actor,id:string,input:{expectedAclVersion:number;visibility:'private'|'public'|'shared';recipientIds:number[];reason?:string}) {
  return useDB().transaction((tx)=>{
    const photo=managedPhoto(actor,id,tx as any)
    if(photo.ownershipType!=='user')throw createError({statusCode:422,message:'站点照片使用所属相册权限'})
    if(photo.transferState!=='idle')throw createError({statusCode:409,message:'文件清理完成后才可修改共享'})
    if(photo.aclVersion!==input.expectedAclVersion)throw createError({statusCode:409,message:'照片权限已修改，请重新加载',data:{code:'PHOTO_ACL_CONFLICT'}})
    if(actor.isAdmin&&actor.user!.id!==photo.ownerId&&!input.reason?.trim())throw createError({statusCode:422,message:'管理员修改他人照片权限须填写原因'})
    const recipients=validateRecipients(tx as any,input.recipientIds,photo.ownerId)
    if((input.visibility==='shared')!==(recipients.length>0))throw createError({statusCode:422,message:'可见范围与接收者名单不匹配'})
    const before=tx.select({id:tables.photoShares.recipientUserId}).from(tables.photoShares).where(eq(tables.photoShares.photoId,id)).all()
    tx.delete(tables.photoShares).where(eq(tables.photoShares.photoId,id)).run()
    if(recipients.length)tx.insert(tables.photoShares).values(recipients.map((recipientUserId)=>({photoId:id,recipientUserId,grantedBy:actor.user!.id}))).run()
    tx.update(tables.photos).set({visibility:input.visibility,aclVersion:photo.aclVersion+1,updatedAt:new Date()}).where(eq(tables.photos.id,id)).run()
    audit(tx as any,actor.user!.id,'photo.visibility','photo',id,{ownerId:photo.ownerId,reason:input.reason,before:{visibility:photo.visibility,recipientIds:before.map(p=>p.id)},after:{visibility:input.visibility,recipientIds:recipients}})
    return {visibility:input.visibility,recipientIds:recipients,aclVersion:photo.aclVersion+1}
  },{behavior:'immediate'})
}

export function editPhotoMetadata(actor:Actor,id:string,input:{expectedVersion:number;title?:string;description?:string;tags?:string[];isPanorama?:number|null;panoYaw?:number|null;panoPitch?:number|null;latitude?:number|null;longitude?:number|null;rating?:number|null;reason?:string}) {
  return useDB().transaction((tx)=>{
    const photo=managedPhoto(actor,id,tx as any)
    if(photo.metadataVersion!==input.expectedVersion)throw createError({statusCode:409,message:'照片资料已修改，请重新加载'})
    if(actor.isAdmin&&photo.ownerId!==null&&actor.user!.id!==photo.ownerId&&!input.reason?.trim())throw createError({statusCode:422,message:'管理员修改他人照片须填写原因'})
    if(photo.transferState==='cleanup_pending'&&['rating','latitude','longitude','isPanorama','panoYaw','panoPitch'].some(key=>(input as Record<string,unknown>)[key]!==undefined))throw createError({statusCode:409,message:'源文件清理完成前仅可修改标题、说明和标签'})
    const {expectedVersion:_version,reason,rating,...patch}=input
    if (rating !== undefined) (patch as any).exif = {...photo.exif,Rating:rating ?? undefined}
    if (patch.latitude !== undefined || patch.longitude !== undefined) Object.assign(patch,{country:null,city:null,locationName:null})
    // Original bytes and EXIF are deliberately untouched.
    const next=tx.update(tables.photos).set({...patch,metadataVersion:photo.metadataVersion+1,updatedAt:new Date()}).where(eq(tables.photos.id,id)).returning().get()!
    audit(tx as any,actor.user!.id,'photo.metadata','photo',id,{ownerId:photo.ownerId,reason,after:{metadataVersion:next.metadataVersion}})
    return next
  },{behavior:'immediate'})
}

export function photoLifecycle(actor:Actor,id:string,action:'trash'|'restore'|'purge'|'retry',reason?:string) {
  return useDB().transaction((tx)=>{
    const photo=managedPhoto(actor,id,tx as any)
    if(photo.transferState!=='idle')throw createError({statusCode:409,message:'文件清理完成后才可执行此操作'})
    if(action==='purge'){
      if(!photo.deletedAt)throw createError({statusCode:409,message:'请先移入回收站'})
      if (['uploading','processing'].includes(photo.processingStatus)) throw createError({ statusCode: 409, message: '请等待文件处理结束后再彻底删除' })
      tx.update(tables.photos).set({processingStatus:'purging'}).where(eq(tables.photos.id,id)).run()
      tx.insert(tables.pipelineQueue).values({payload:{type:'photo-purge',photoId:id},photoId:id,dedupeKey:`purge:${id}`}).onConflictDoNothing().run()
    }else if(action==='retry'){
      if(photo.processingStatus!=='failed'||photo.deletedAt||photo.source!=='upload')throw createError({statusCode:409,message:'当前照片不能重试'})
      const session=tx.select({id:tables.uploadSessions.id}).from(tables.uploadSessions).where(eq(tables.uploadSessions.photoId,id)).get()
      if(!session)throw createError({statusCode:409,message:'Upload history missing'})
      tx.update(tables.photos).set({processingStatus:'processing',processingErrorCode:null}).where(eq(tables.photos.id,id)).run()
      tx.insert(tables.pipelineQueue).values({payload:{type:'photo-process',photoId:id,uploadSessionId:session.id},photoId:id,uploadSessionId:session.id,dedupeKey:`process:${id}`}).onConflictDoNothing().run()
    }else{
      tx.update(tables.photos).set({deletedAt:action==='trash'?new Date():null,metadataVersion:photo.metadataVersion+1,updatedAt:new Date()}).where(eq(tables.photos.id,id)).run()
    }
    audit(tx as any,actor.user!.id,`photo.${action}`,'photo',id,{ownerId:photo.ownerId,reason})
    return {success:true}
  },{behavior:'immediate'})
}

export function moderatePhoto(actor:Actor,id:string,input:{blocked:boolean;reason:string}) {
  if(!actor.isAdmin)throw createError({statusCode:403,message:'Admin privileges required'})
  return useDB().transaction((tx)=>{
    const photo=managedPhoto(actor,id,tx as any)
    tx.update(tables.photos).set({moderationStatus:input.blocked?'blocked':'visible',moderationReason:input.blocked?input.reason:null,aclVersion:photo.aclVersion+1,updatedAt:new Date()}).where(eq(tables.photos.id,id)).run()
    audit(tx as any,actor.user!.id,'photo.moderate','photo',id,{ownerId:photo.ownerId,reason:input.reason,after:{blocked:input.blocked}})
    return {success:true}
  },{behavior:'immediate'})
}
