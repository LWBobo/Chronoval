import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { promises as fs, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { tables, useDB } from '../../utils/db'
import type { Actor } from '../../utils/access'
import { FixedStore, claimKey, randomId } from '../media-files/store'
import { reserveQuota } from '../uploads'
import { assertAdmin, assertCurrentActor, audit } from '../users'
import { managedPhoto } from './index'
import { reconcilePeople } from '../ml/person.service'
import { discardFailedDerivatives } from './failed-files'

export async function startOwnershipTransfer(actor:Actor,photoId:string,input:{toUserId:number;expectedAclVersion:number;idempotencyKey:string;reason:string},deletionTaskId?:string) {
  assertAdmin(actor)
  function loadPhoto(db=useDB()) {
    if (!deletionTaskId) return managedPhoto(actor,photoId,db)
    const task=db.select().from(tables.userDeletionTasks).where(eq(tables.userDeletionTasks.id,deletionTaskId)).get()
    const photo=db.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
    if(!task||!['pending','running'].includes(task.state)||task.mode!=='transfer'||task.actorUserId!==actor.user!.id||task.targetUserId!==input.toUserId||!photo||task.userId!==photo.ownerId)throw new Error('Invalid deletion transfer scope')
    return photo
  }
  const requestDigest=createHash('sha256').update(JSON.stringify({photoId,...input})).digest('hex')
  const prior=useDB().select().from(tables.photoOwnershipTransfers).where(and(eq(tables.photoOwnershipTransfers.actorUserId,actor.user.id),eq(tables.photoOwnershipTransfers.idempotencyKey,input.idempotencyKey))).get()
  if(prior){if(prior.requestDigest!==requestDigest)throw createError({statusCode:409,message:'幂等键已用于其他转移'});return transferDto(prior.id)}
  const photo=loadPhoto()
  if(photo.aclVersion!==input.expectedAclVersion)throw createError({statusCode:409,message:'照片权限已变化，请刷新'})
  if(photo.ownershipType!=='user'||!['ready','failed'].includes(photo.processingStatus)||photo.transferState!=='idle')throw createError({statusCode:409,message:'此照片目前不能转移'})
  const target=useDB().select().from(tables.users).where(eq(tables.users.id,input.toUserId)).get()
  if(!target||target.status!=='active'||target.id===photo.ownerId)throw createError({statusCode:422,message:'请选择另一位有效用户'})
  if(photo.processingStatus==='failed')await discardFailedDerivatives(photoId)
  const files=useDB().select().from(tables.photoFiles).where(eq(tables.photoFiles.photoId,photoId)).all()
  if(!files.length||files.some((f)=>f.locatorType==='library'||f.state!=='ready'))throw createError({statusCode:409,message:'照片文件不完整，请先重试处理或清理失败文件'})
  let collision=false
  const planned:Array<{file:typeof tables.photoFiles.$inferSelect;root:string;relative:string;key:string}>=[]
  for(const file of files.filter((f)=>f.locatorType==='provider')){
    const store=new FixedStore(file.storageProviderId!),root=store.userRoot(target.username)
    const relative=file.isBillableOriginal?file.uploadRelativePath:`.chronoval/${photoId}/${path.posix.basename(file.storageKey!)}`
    if(!relative)throw createError({statusCode:409,message:'原文件目录记录缺失'})
    const key=`${root}/${relative}`
    if(file.isBillableOriginal&&(await store.meta(key)||useDB().select({id:tables.storagePathClaims.id}).from(tables.storagePathClaims).where(and(eq(tables.storagePathClaims.storageProviderId,file.storageProviderId!),eq(tables.storagePathClaims.storageKeyNormalized,claimKey(key)))).get()))collision=true
    planned.push({file,root,relative,key})
  }
  const id=randomId()
  const bytesByProvider = new Map<number, number>()
  for (const { file } of planned) bytesByProvider.set(file.storageProviderId!, (bytesByProvider.get(file.storageProviderId!) ?? 0) + file.byteSize)
  for (const [providerId, bytes] of bytesByProvider) await new FixedStore(providerId).assertCapacity(bytes)
  return useDB().transaction((tx)=>{
    if (!deletionTaskId) assertCurrentActor(tx as any, actor, true)
    const duplicate=tx.select().from(tables.photoOwnershipTransfers).where(and(eq(tables.photoOwnershipTransfers.actorUserId,actor.user.id),eq(tables.photoOwnershipTransfers.idempotencyKey,input.idempotencyKey))).get()
    if(duplicate){if(duplicate.requestDigest!==requestDigest)throw createError({statusCode:409,message:'幂等键已用于其他转移'});return transferDto(duplicate.id,tx as any)}
    const current=loadPhoto(tx as any)
    const to=tx.select().from(tables.users).where(eq(tables.users.id,target.id)).get()
    if(!to||to.status!=='active'||current.ownerId!==photo.ownerId||current.aclVersion!==input.expectedAclVersion||current.transferState!=='idle'||!['ready','failed'].includes(current.processingStatus))throw createError({statusCode:409,message:'照片或目标账号状态已变化，请刷新'})
    reserveQuota(tx as any,target.id,current.originalBytes)
    for (const p of planned) if (p.file.isBillableOriginal && tx.select({id:tables.storagePathClaims.id}).from(tables.storagePathClaims).where(and(eq(tables.storagePathClaims.storageProviderId,p.file.storageProviderId!),eq(tables.storagePathClaims.storageKeyNormalized,claimKey(p.key)))).get()) collision=true
    const currentFiles=tx.select().from(tables.photoFiles).where(eq(tables.photoFiles.photoId,photoId)).all()
    if(currentFiles.length!==files.length||files.some(f=>!currentFiles.some(c=>c.id===f.id&&c.contentVersion===f.contentVersion&&c.state==='ready'&&c.storageKey===f.storageKey)))throw createError({statusCode:409,message:'文件清单已变化，请刷新'})
    const shares=tx.select({id:tables.photoShares.recipientUserId}).from(tables.photoShares).where(eq(tables.photoShares.photoId,photoId)).all()
    tx.insert(tables.photoOwnershipTransfers).values({id,photoId,photoIdSnapshot:photoId,requestDigest,sourceAclVersion:current.aclVersion,sourceMetadataVersion:current.metadataVersion,fromUserId:current.ownerId!,toUserId:target.id,actorUserId:actor.user.id,idempotencyKey:input.idempotencyKey,state:'preparing',reason:input.reason,originalAclJson:{visibility:current.visibility,recipients:shares.map((s)=>s.id)},reservedBytes:current.originalBytes,targetReservedBytes:current.originalBytes}).run()
    for(const p of planned){
      const key=p.file.isBillableOriginal&&collision?`${p.root}/_duplicates/${photoId}/${p.relative}`:p.key
      tx.insert(tables.storagePathClaims).values({id:randomId(),storageProviderId:p.file.storageProviderId!,storageKeyNormalized:claimKey(key),holderType:'transfer',holderId:id}).run()
      tx.insert(tables.photoTransferFiles).values({id:randomId(),transferId:id,fileId:p.file.id,role:p.file.role,sourceContentVersion:p.file.contentVersion,locatorType:'provider',storageProviderId:p.file.storageProviderId!,sourceKey:p.file.storageKey!,targetKey:key,byteSize:p.file.byteSize,checksumSha256:p.file.checksumSha256}).run()
    }
    for(const file of files.filter(f=>f.locatorType==='embedded'))tx.insert(tables.photoTransferFiles).values({id:randomId(),transferId:id,fileId:file.id,role:file.role,sourceContentVersion:file.contentVersion,locatorType:'embedded',parentFileId:file.parentFileId,byteOffset:file.byteOffset,byteLength:file.byteLength,byteSize:file.byteSize,state:'verified',sourceDeleted:true}).run()
    tx.update(tables.photos).set({transferState:'moving',activeTransferId:id,updatedAt:new Date()}).where(eq(tables.photos.id,photoId)).run()
    tx.insert(tables.pipelineQueue).values({payload:{type:'ownership-transfer',transferId:id},photoId,dedupeKey:`transfer:${id}`,maxAttempts:5}).run()
    audit(tx as any,actor.user.id,'photo.transfer-start','photo',photoId,{ownerId:current.ownerId,reason:input.reason,after:{transferId:id,toUserId:target.id}})
    return transferDto(id,tx as any)
  },{behavior:'immediate'})
}

export function transferDto(id:string,db=useDB()) {
  const row=db.select().from(tables.photoOwnershipTransfers).where(eq(tables.photoOwnershipTransfers.id,id)).get()
  if(!row)throw createError({statusCode:404,message:'Transfer not found'})
  const files=db.select({state:tables.photoTransferFiles.state,sourceDeleted:tables.photoTransferFiles.sourceDeleted,byteSize:tables.photoTransferFiles.byteSize,locatorType:tables.photoTransferFiles.locatorType}).from(tables.photoTransferFiles).where(eq(tables.photoTransferFiles.transferId,id)).all()
  return {id:row.id,photoId:row.photoIdSnapshot,photoIdSnapshot:row.photoIdSnapshot,fromUserId:row.fromUserId,toUserId:row.toUserId,state:row.state,errorCode:row.errorCode,completedAt:row.completedAt,cutoverAt:row.cutoverAt,filesTotal:files.length,filesVerified:files.filter(f=>f.state==='verified').length,sourcesDeleted:files.filter(f=>f.sourceDeleted).length,bytesTotal:files.filter(f=>f.locatorType==='provider').reduce((sum,f)=>sum+f.byteSize,0),bytesVerified:files.filter(f=>f.locatorType==='provider'&&f.state==='verified').reduce((sum,f)=>sum+f.byteSize,0)}
}

export function retryTransferCleanup(actor: Actor, id: string, reason: string) {
  return useDB().transaction(tx => {
    assertCurrentActor(tx as any, actor, true)
    const transfer = tx.select().from(tables.photoOwnershipTransfers).where(eq(tables.photoOwnershipTransfers.id, id)).get()
    if (!transfer?.cutoverAt || transfer.state !== 'cleanup_pending' || (transfer.leaseExpiresAt?.getTime() ?? 0) > Date.now()) throw createError({ statusCode: 409, message: '仅可重试已停止的源文件清理任务' })
    tx.insert(tables.pipelineQueue).values({ payload: { type: 'ownership-transfer-cleanup', transferId: id }, photoId: transfer.photoId, dedupeKey: `transfer:${id}`, maxAttempts: 5, priority: -1 }).onConflictDoNothing().run()
    tx.update(tables.photoOwnershipTransfers).set({ errorCode: null, updatedAt: new Date() }).where(eq(tables.photoOwnershipTransfers.id, id)).run()
    audit(tx as any, actor.user!.id, 'photo.transfer-cleanup-retry', 'photo', transfer.photoIdSnapshot, { ownerId: transfer.toUserId, reason, after: { transferId: id } })
    return transferDto(id, tx as any)
  }, { behavior: 'immediate' })
}

export async function processOwnershipTransfer(id:string):Promise<boolean> {
  const db=useDB(),lease=randomId()
  const row=db.transaction((tx)=>{
    const t=tx.select().from(tables.photoOwnershipTransfers).where(eq(tables.photoOwnershipTransfers.id,id)).get()
    if(!t||['completed','failed'].includes(t.state))return null
    if(t.leaseToken&&(t.leaseExpiresAt?.getTime()??0)>Date.now())return false
    tx.update(tables.photoOwnershipTransfers).set({leaseToken:lease,leaseEpoch:t.leaseEpoch+1,leaseExpiresAt:new Date(Date.now()+1800000),state:t.cutoverAt?'cleanup_pending':t.state==='rolling_back'?'rolling_back':'copying',updatedAt:new Date()}).where(eq(tables.photoOwnershipTransfers.id,id)).run()
    return t
  },{behavior:'immediate'})
  if(row===false)return false
  if(!row)return true
  const leaseEpoch=row.leaseEpoch+1
  function fence(){
    const current=db.select().from(tables.photoOwnershipTransfers).where(eq(tables.photoOwnershipTransfers.id,id)).get()
    if(!current||current.leaseToken!==lease||current.leaseEpoch!==leaseEpoch)throw new Error('Transfer lease lost')
    db.update(tables.photoOwnershipTransfers).set({leaseExpiresAt:new Date(Date.now()+1800000),updatedAt:new Date()}).where(and(eq(tables.photoOwnershipTransfers.id,id),eq(tables.photoOwnershipTransfers.leaseToken,lease))).run()
    return current
  }
  const files=db.select().from(tables.photoTransferFiles).where(eq(tables.photoTransferFiles.transferId,id)).all()
  const heartbeat=setInterval(()=>{try{fence()}catch{}},10000)
  heartbeat.unref()
  let dir: string | undefined
  try{
    dir=await fs.mkdtemp(path.join(tmpdir(),'chronoval-transfer-'))
    if(row.state==='rolling_back')throw new Error('Resume transfer rollback')
    if(!row.cutoverAt){
      for(const file of files.filter(f=>f.locatorType==='provider')){
        fence()
        const store=new FixedStore(file.storageProviderId!)
        const sourceHash=file.checksumSha256||await store.checksum(file.sourceKey!)
        db.update(tables.photoTransferFiles).set({checksumSha256:sourceHash}).where(eq(tables.photoTransferFiles.id,file.id)).run()
        let targetMeta=await store.meta(file.targetKey!)
        if(!targetMeta){
          let local=await store.localPath(file.sourceKey!)
          if(!local){local=path.join(dir,file.id);await pipeline(await store.read(file.sourceKey!),createWriteStream(local,{flags:'wx'}))}
          fence()
          try{await store.createExclusive(file.targetKey!,local,'application/octet-stream')}catch(e:any){if(e.code!=='EEXIST'&&e.$metadata?.httpStatusCode!==412)throw e}
          targetMeta=await store.meta(file.targetKey!)
        }
        if(targetMeta?.size!==file.byteSize||await store.checksum(file.targetKey!)!==sourceHash)throw new Error('Transfer target verification failed')
        fence()
        db.update(tables.photoTransferFiles).set({state:'verified',checksumSha256:sourceHash}).where(eq(tables.photoTransferFiles.id,file.id)).run()
      }
      db.transaction((tx)=>{
        const current=fence()
        const photo=tx.select().from(tables.photos).where(eq(tables.photos.id,row.photoIdSnapshot)).get()
        const target=tx.select().from(tables.users).where(eq(tables.users.id,row.toUserId)).get()
        const manifest=tx.select().from(tables.photoTransferFiles).where(eq(tables.photoTransferFiles.transferId,id)).all()
        if(!photo||photo.activeTransferId!==id||photo.ownerId!==row.fromUserId||photo.aclVersion!==row.sourceAclVersion||photo.metadataVersion!==row.sourceMetadataVersion||target?.status!=='active'||manifest.some(f=>f.state!=='verified'))throw new Error('Transfer state changed before cutover')
        const inventory=tx.select().from(tables.photoFiles).where(eq(tables.photoFiles.photoId,row.photoIdSnapshot)).all()
        if(inventory.length!==manifest.length||manifest.some(f=>!inventory.some(c=>c.id===f.fileId&&c.contentVersion===f.sourceContentVersion&&c.state==='ready'&&c.locatorType===f.locatorType&&(f.locatorType==='provider'?c.storageKey===f.sourceKey&&c.storageProviderId===f.storageProviderId:c.parentFileId===f.parentFileId&&c.byteOffset===f.byteOffset&&c.byteLength===f.byteLength))))throw new Error('File inventory changed before cutover')
        for(const file of manifest.filter(f=>f.locatorType==='provider'))tx.update(tables.photoFiles).set({storageKey:file.targetKey,updatedAt:new Date()}).where(eq(tables.photoFiles.id,file.fileId)).run()
        tx.delete(tables.photoShares).where(eq(tables.photoShares.photoId,row.photoIdSnapshot)).run()
        const original=tx.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId,row.photoIdSnapshot),eq(tables.photoFiles.role,'original'))).get()!
        const root=new FixedStore(original.storageProviderId!).userRoot(target.username)
        const oldPeople=tx.select({id:tables.assetFaces.personId}).from(tables.assetFaces).where(eq(tables.assetFaces.photoId,row.photoIdSnapshot)).all()
        // Remove the old owner's associations before changing the partition.
        tx.delete(tables.assetFaces).where(eq(tables.assetFaces.photoId,row.photoIdSnapshot)).run()
        tx.update(tables.photos).set({ownerId:row.toUserId,visibility:'private',transferState:'cleanup_pending',aclVersion:photo.aclVersion+1,metadataVersion:photo.metadataVersion+1,faceScannedAt:null,storageRelativePath:original.storageKey!.slice(root.length+1),updatedAt:new Date()}).where(eq(tables.photos.id,row.photoIdSnapshot)).run()
        reconcilePeople(oldPeople.flatMap(person=>person.id?[person.id]:[]))
        tx.update(tables.userStorageUsage).set({usedBytes:sql`${tables.userStorageUsage.usedBytes}-${row.reservedBytes}`,updatedAt:new Date()}).where(eq(tables.userStorageUsage.userId,row.fromUserId)).run()
        tx.update(tables.userStorageUsage).set({usedBytes:sql`${tables.userStorageUsage.usedBytes}+${row.reservedBytes}`,reservedBytes:sql`${tables.userStorageUsage.reservedBytes}-${row.reservedBytes}`,updatedAt:new Date()}).where(eq(tables.userStorageUsage.userId,row.toUserId)).run()
        tx.update(tables.photoOwnershipTransfers).set({state:'cleanup_pending',targetReservedBytes:0,cutoverAt:new Date(),updatedAt:new Date()}).where(eq(tables.photoOwnershipTransfers.id,id)).run()
        audit(tx as any,row.actorUserId,'photo.transfer-cutover','photo',row.photoIdSnapshot,{ownerId:row.toUserId,reason:row.reason,before:{ownerId:row.fromUserId},after:{ownerId:row.toUserId,visibility:'private'}})
      },{behavior:'immediate'})
    }
    for(const file of files.filter(f=>f.locatorType==='provider')){
      fence()
      if(!file.sourceDeleted){
        const store=new FixedStore(file.storageProviderId!)
        const latest=db.select().from(tables.photoTransferFiles).where(eq(tables.photoTransferFiles.id,file.id)).get()!
        if((await store.meta(file.targetKey!))?.size!==file.byteSize||await store.checksum(file.targetKey!)!==latest.checksumSha256)throw new Error('Transfer destination changed during cleanup')
        const source=await store.meta(file.sourceKey!)
        if(source&&(source.size!==file.byteSize||await store.checksum(file.sourceKey!)!==latest.checksumSha256))throw new Error('Source changed during cleanup')
        await store.remove(file.sourceKey!);fence();db.update(tables.photoTransferFiles).set({sourceDeleted:true}).where(eq(tables.photoTransferFiles.id,file.id)).run()
      }
    }
    db.transaction((tx)=>{
      fence()
      for(const file of files.filter(f=>f.locatorType==='provider'))tx.delete(tables.storagePathClaims).where(and(eq(tables.storagePathClaims.storageProviderId,file.storageProviderId!),eq(tables.storagePathClaims.storageKeyNormalized,claimKey(file.sourceKey!)),eq(tables.storagePathClaims.holderId,row.photoIdSnapshot))).run()
      tx.update(tables.storagePathClaims).set({holderType:'file',holderId:row.photoIdSnapshot}).where(and(eq(tables.storagePathClaims.holderType,'transfer'),eq(tables.storagePathClaims.holderId,id))).run()
      tx.update(tables.photoOwnershipTransfers).set({state:'completed',completedAt:new Date(),leaseToken:null,leaseExpiresAt:null,errorCode:null,updatedAt:new Date()}).where(eq(tables.photoOwnershipTransfers.id,id)).run()
      tx.update(tables.photos).set({transferState:'idle',activeTransferId:null,updatedAt:new Date()}).where(and(eq(tables.photos.id,row.photoIdSnapshot),eq(tables.photos.activeTransferId,id))).run()
      audit(tx as any,row.actorUserId,'photo.transfer-complete','photo',row.photoIdSnapshot,{ownerId:row.toUserId,reason:row.reason})
    },{behavior:'immediate'})
    // Optional indexing must not turn a completed ownership cutover back into cleanup.
    try { const {enqueueMlJobsForPhoto}=await import('../ml/enqueue');await enqueueMlJobsForPhoto(row.photoIdSnapshot) }
    catch { logger.dynamic('transfer').warn('Photo indexing can be retried after the completed transfer') }
    return true
  }catch(error){
    const current=fence()
    if(!current.cutoverAt){
      db.update(tables.photoOwnershipTransfers).set({state:'rolling_back',errorCode:'TRANSFER_COPY_FAILED'}).where(eq(tables.photoOwnershipTransfers.id,id)).run()
      for(const file of files.filter(f=>f.locatorType==='provider')){
        fence()
        const store=new FixedStore(file.storageProviderId!),meta=await store.meta(file.targetKey!)
        if(meta){
          const latest=db.select().from(tables.photoTransferFiles).where(eq(tables.photoTransferFiles.id,file.id)).get()!
          if(!latest.checksumSha256||meta.size!==file.byteSize||await store.checksum(file.targetKey!)!==latest.checksumSha256)throw new Error('Rollback target requires administrator review')
          await store.remove(file.targetKey!)
        }
      }
      db.transaction((tx)=>{
        fence()
        tx.update(tables.userStorageUsage).set({reservedBytes:sql`${tables.userStorageUsage.reservedBytes}-${row.reservedBytes}`,updatedAt:new Date()}).where(eq(tables.userStorageUsage.userId,row.toUserId)).run()
        tx.delete(tables.storagePathClaims).where(and(eq(tables.storagePathClaims.holderType,'transfer'),eq(tables.storagePathClaims.holderId,id))).run()
        tx.update(tables.photos).set({transferState:'idle',activeTransferId:null}).where(and(eq(tables.photos.id,row.photoIdSnapshot),eq(tables.photos.activeTransferId,id))).run()
        tx.update(tables.photoOwnershipTransfers).set({state:'failed',targetReservedBytes:0,leaseToken:null,leaseExpiresAt:null,updatedAt:new Date()}).where(eq(tables.photoOwnershipTransfers.id,id)).run()
        audit(tx as any,row.actorUserId,'photo.transfer-rollback','photo',row.photoIdSnapshot,{ownerId:row.fromUserId,reason:row.reason})
      },{behavior:'immediate'})
    }else db.update(tables.photoOwnershipTransfers).set({state:'cleanup_pending',errorCode:'SOURCE_CLEANUP_FAILED',leaseToken:null,leaseExpiresAt:null,updatedAt:new Date()}).where(eq(tables.photoOwnershipTransfers.id,id)).run()
    throw error
  }finally{
    clearInterval(heartbeat)
    db.update(tables.photoOwnershipTransfers).set({leaseToken:null,leaseExpiresAt:null}).where(and(eq(tables.photoOwnershipTransfers.id,id),eq(tables.photoOwnershipTransfers.leaseToken,lease))).run()
    if(dir)await fs.rm(dir,{recursive:true,force:true})
  }
}
