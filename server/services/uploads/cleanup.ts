import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tables, useDB } from '../../utils/db'
import { FixedStore } from '../media-files/store'
import type { Actor } from '../../utils/access'

const cleanups = new Map<string, Promise<void>>()
export function cleanupUploadSession(id: string): Promise<void> {
  const current = cleanups.get(id)
  if (current) return current
  const work = cleanupSession(id).finally(() => cleanups.delete(id))
  cleanups.set(id, work)
  return work
}

async function cleanupSession(id:string) {
  if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid upload ID')
  const db=useDB()
  const session=db.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()
  if(!session||session.stagingCleanedAt)return
  const parts=db.select().from(tables.uploadParts).where(eq(tables.uploadParts.sessionId,id)).all()
  if(parts.some((p)=>(p.leaseExpiresAt?.getTime()??0)>Date.now()))return
  if(!['cancelled','expired','committed'].includes(session.state))return
  if(session.state!=='committed'){
    const store=new FixedStore(session.storageProviderId)
    for(const p of parts){
      const meta=await store.meta(p.finalKey)
      if(meta){
        if(!p.checksumSha256||meta.size!==p.receivedBytes||await store.checksum(p.finalKey)!==p.checksumSha256)throw new Error('Unconfirmed upload target, cleanup requires administrator review')
        await store.remove(p.finalKey)
      }
    }
  }
  const root=path.resolve('data/.uploads')
  const target=path.resolve(root,id)
  if(path.dirname(target)!==root)throw new Error('Invalid cleanup path')
  await fs.rm(target,{recursive:true,force:true})
  if(session.state==='committed'){
    db.update(tables.uploadSessions).set({stagingCleanedAt:new Date()}).where(eq(tables.uploadSessions.id,id)).run()
    return
  }
  db.transaction((tx)=>{
    const current=tx.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()!
    if(!['cancelled','expired'].includes(current.state))throw new Error('Upload state changed during cleanup')
    tx.update(tables.uploadParts).set({state:'deleted',leaseToken:null,leaseExpiresAt:null}).where(eq(tables.uploadParts.sessionId,id)).run()
    if(current.reservedBytes && current.ownerUserId)tx.update(tables.userStorageUsage).set({reservedBytes:sql`${tables.userStorageUsage.reservedBytes}-${current.reservedBytes}`,updatedAt:new Date()}).where(eq(tables.userStorageUsage.userId,current.ownerUserId)).run()
    tx.update(tables.uploadSessions).set({reservedBytes:0,stagingCleanedAt:new Date(),updatedAt:new Date()}).where(eq(tables.uploadSessions.id,id)).run()
    tx.delete(tables.storagePathClaims).where(and(eq(tables.storagePathClaims.holderType,'upload'),eq(tables.storagePathClaims.holderId,id))).run()
    if(current.photoId)tx.delete(tables.photos).where(and(eq(tables.photos.id,current.photoId),eq(tables.photos.processingStatus,'uploading'))).run()
  },{behavior:'immediate'})
}

export async function cancelUpload(id:string,actor:Actor) {
  const db=useDB()
  db.transaction((tx)=>{
    const session=tx.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()
    if(!session||session.actorUserId!==actor.user?.id)throw createError({statusCode:404,message:'Upload not found'})
    if(session.state==='committed')throw createError({statusCode:409,message:'上传已完成，请在照片管理中删除'})
    tx.update(tables.uploadSessions).set({state:'cancelled',updatedAt:new Date()}).where(eq(tables.uploadSessions.id,id)).run()
  },{behavior:'immediate'})
  await cleanupUploadSession(id)
  return {cancelled:true}
}

export async function cleanupExpiredUploads() {
  const db=useDB()
  db.update(tables.uploadSessions).set({state:'cancelled',updatedAt:new Date()}).where(and(inArray(tables.uploadSessions.state,['created','uploading','finalizing']),sql`(EXISTS(SELECT 1 FROM users u WHERE u.id=${tables.uploadSessions.ownerUserId} AND u.status!='active') OR EXISTS(SELECT 1 FROM users a WHERE a.id=${tables.uploadSessions.actorUserId} AND a.status!='active'))`)).run()
  db.update(tables.uploadSessions).set({state:'expired'}).where(and(inArray(tables.uploadSessions.state,['created','uploading','finalizing']),lt(tables.uploadSessions.expiresAt,new Date()))).run()
  const sessions=db.select({id:tables.uploadSessions.id}).from(tables.uploadSessions).where(and(isNull(tables.uploadSessions.stagingCleanedAt),inArray(tables.uploadSessions.state,['expired','cancelled','committed']))).limit(100).all()
  for(const s of sessions)await cleanupUploadSession(s.id).catch((e)=>logger.dynamic('uploads').warn('Deferred upload cleanup',e instanceof Error?e.message:'error'))
}
