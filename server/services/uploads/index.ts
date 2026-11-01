import { and, eq, inArray, sql } from 'drizzle-orm'
import { createWriteStream, createReadStream, promises as fs } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { fileTypeFromFile } from 'file-type'
import type { H3Event } from 'h3'
import { tables, useDB } from '../../utils/db'
import type { Actor } from '../../utils/access'
import { validateUploadPath } from '../../utils/identity'
import { assertCurrentActor, validateRecipients, audit } from '../users'
import { FixedStore, randomId, claimKey } from '../media-files/store'
import { settingsManager } from '../settings/settingsManager'
import { MAX_UPLOAD_BYTES as MAX_BYTES, MAX_IMAGE_BYTES, managedUploadLimits } from './limits'

export const uploadInputSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  visibility: z.enum(['private', 'public', 'shared']).default('private'),
  stripLocation: z.boolean().default(false),
  recipientIds: z.array(z.number().int().positive()).max(100).default([]),
  parts: z.array(z.object({ role: z.enum(['original', 'live_video']), relativePath: z.string().min(1).max(1024), size: z.number().int().positive().max(MAX_BYTES), mime: z.string().max(255).default('application/octet-stream') }).strict()).min(1).max(2),
}).strict().superRefine((v,ctx) => {
  if (v.parts.filter((p) => p.role === 'original').length !== 1 || new Set(v.parts.map((p) => p.role)).size !== v.parts.length) ctx.addIssue({ code: 'custom', path: ['parts'], message: '每次上传必须包含一个原文件，可选一个配对视频' })
  if ((v.visibility === 'shared') !== (v.recipientIds.length > 0)) ctx.addIssue({ code: 'custom', path: ['recipientIds'], message: '指定用户可见须选择接收者，其他模式须清空名单' })
})

function uploadActor(db: ReturnType<typeof useDB>, actor: Actor) {
  const row = actor.user ? db.select().from(tables.users).where(eq(tables.users.id,actor.user.id)).get() : null
  if (!row || row.status !== 'active' || row.authVersion !== actor.user?.authVersion || row.mustChangePassword) throw createError({ statusCode: 401, message: 'Authentication required' })
  if (!row.canUpload) throw createError({ statusCode: 403, message: '管理员已关闭此账号上传权限' })
  return row
}

export function reserveQuota(db: ReturnType<typeof useDB>, userId: number, bytes: number) {
  const user = db.select().from(tables.users).where(eq(tables.users.id,userId)).get()!
  const usage = db.select().from(tables.userStorageUsage).where(eq(tables.userStorageUsage.userId,userId)).get()
  if (!usage || !Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(usage.usedBytes + usage.reservedBytes + bytes)) throw createError({ statusCode: 409, message: '空间账本异常，请联系管理员' })
  if (user.storageQuotaBytes !== null && usage.usedBytes + usage.reservedBytes + bytes > user.storageQuotaBytes) throw createError({ statusCode: 409, message: '存储配额不足', data: { code: 'QUOTA_EXCEEDED' } })
  db.update(tables.userStorageUsage).set({ reservedBytes: usage.reservedBytes + bytes, updatedAt: new Date() }).where(eq(tables.userStorageUsage.userId,userId)).run()
}

export async function initializeUpload(actor: Actor, input: z.infer<typeof uploadInputSchema>, ownerUserId?: number | null) {
  const user = uploadActor(useDB(),actor)
  if (ownerUserId !== undefined) assertCurrentActor(useDB(), actor, true)
  const owner = ownerUserId === undefined ? user : ownerUserId === null ? null : useDB().select().from(tables.users).where(eq(tables.users.id, ownerUserId)).get()
  if (ownerUserId !== null && (!owner || owner.status !== 'active')) throw createError({ statusCode: 422, message: '上传所有者无效' })
  if (owner === null && (input.visibility !== 'private' || input.recipientIds.length)) throw createError({ statusCode: 422, message: '站点上传的权限由相册控制' })
  const { maxFileBytes: maxBytes } = await managedUploadLimits()
  if(input.parts.some(part=>part.size>maxBytes))throw createError({statusCode:413,message:'文件超过站点上传大小限制'})
  const normalized = input.parts.map((part) => ({ ...part, relativePath: validateUploadPath(part.relativePath) }))
  if(new Set(normalized.map(p=>claimKey(p.relativePath))).size!==normalized.length)throw createError({statusCode:422,message:'同一组上传中不能包含重复路径'})
  const digest = createHash('sha256').update(JSON.stringify({ ...input, ownerUserId:owner?.id??null, recipientIds:[...new Set(input.recipientIds)].sort((a,b)=>a-b), parts: normalized })).digest('hex')
  const existing = useDB().select().from(tables.uploadSessions).where(and(eq(tables.uploadSessions.actorUserId,user.id),eq(tables.uploadSessions.idempotencyKey,input.idempotencyKey))).get()
  if (existing) {
    if (existing.requestDigest !== digest) throw createError({ statusCode: 409, message: '幂等键已用于不同上传' })
    return uploadDto(existing.id,actor)
  }
  const active = await settingsManager.storage.getActiveProvider()
  if (!active) throw createError({ statusCode: 409, message: '请管理员先配置存储' })
  const store = new FixedStore(active.id)
  if (!store.supportsManagedUploads) throw createError({ statusCode: 501, message: '当前存储不支持安全的个人上传，请使用本地或 S3 存储' })
  const id = randomId(), photoId = randomId()
  const root = owner ? store.userRoot(owner.username) : store.siteRoot(photoId)
  const occupied = (await Promise.all(normalized.map((p) => store.meta(`${root}/${p.relativePath}`)))).some(Boolean)
  const bytes = normalized.reduce((n,p) => n+p.size,0)
  await store.assertCapacity(bytes)
  return useDB().transaction((tx) => {
    uploadActor(tx as any,actor)
    if(ownerUserId!==undefined)assertCurrentActor(tx as any,actor,true)
    if(owner){const currentOwner=tx.select().from(tables.users).where(eq(tables.users.id,owner.id)).get();if(currentOwner?.status!=='active')throw createError({statusCode:409,message:'上传所有者状态已改变'})}
    const duplicate = tx.select().from(tables.uploadSessions).where(and(eq(tables.uploadSessions.actorUserId,user.id),eq(tables.uploadSessions.idempotencyKey,input.idempotencyKey))).get()
    if (duplicate) {
      if (duplicate.requestDigest !== digest) throw createError({ statusCode: 409, message: '幂等键已用于不同上传' })
      return uploadDto(duplicate.id,actor,tx as any)
    }
    const count = tx.select({ count: sql<number>`count(*)` }).from(tables.uploadSessions).where(and(eq(tables.uploadSessions.actorUserId,user.id),inArray(tables.uploadSessions.state,['created','uploading','finalizing']))).get()!.count
    if (count >= 50) throw createError({ statusCode: 429, message: '未完成上传过多，请完成或取消后重试' })
    const recipients = validateRecipients(tx as any,input.recipientIds,owner?.id)
    if(owner)reserveQuota(tx as any,owner.id,bytes)
    let conflicts = occupied
    for (const part of normalized) if (tx.select({ id: tables.storagePathClaims.id }).from(tables.storagePathClaims).where(and(eq(tables.storagePathClaims.storageProviderId,active.id),eq(tables.storagePathClaims.storageKeyNormalized,claimKey(`${root}/${part.relativePath}`)))).get()) conflicts=true
    const parts = normalized.map((p) => ({ ...p, finalKey: `${root}/${conflicts ? `_duplicates/${photoId}/` : ''}${p.relativePath}` }))
    tx.insert(tables.photos).values({ id: photoId, ownershipType: owner?'user':'site', ownerId: owner?.id??null, uploadedBy: user.id, visibility: owner?input.visibility:'inherit', processingStatus: 'uploading', stripLocation:input.stripLocation, originalFilename: path.posix.basename(parts.find((p) => p.role==='original')!.relativePath), uploadRelativePath: parts.find((p) => p.role==='original')!.relativePath, storageRelativePath: parts.find((p) => p.role==='original')!.finalKey.slice(root.length+1) }).run()
    tx.insert(tables.uploadSessions).values({ id,actorUserId:user.id,ownerUserId:owner?.id??null,photoId,photoIdSnapshot:photoId,storageProviderId:active.id,idempotencyKey:input.idempotencyKey,requestDigest:digest,reservedBytes:owner?bytes:0,expiresAt:new Date(Date.now()+3600000) }).run()
    for (const p of parts) {
      const partId=randomId()
      tx.insert(tables.uploadParts).values({ id:partId,sessionId:id,role:p.role,originalFilename:path.posix.basename(p.relativePath),uploadRelativePath:p.relativePath,declaredMime:p.mime,expectedBytes:p.size,stagingKey:`data/.uploads/${id}/${partId}`,finalKey:p.finalKey }).run()
      tx.insert(tables.storagePathClaims).values({ id:randomId(),storageProviderId:active.id,storageKeyNormalized:claimKey(p.finalKey),holderType:'upload',holderId:id }).run()
    }
    if(recipients.length)tx.insert(tables.photoShares).values(recipients.map((recipientUserId)=>({photoId,recipientUserId,grantedBy:user.id}))).run()
    return uploadDto(id,actor,tx as any)
  }, { behavior:'immediate' })
}

function sessionActor(db:ReturnType<typeof useDB>,actor:Actor,session:typeof tables.uploadSessions.$inferSelect){
  const current=uploadActor(db,actor)
  if(current.id!==session.actorUserId)throw createError({statusCode:404,message:'Upload not found'})
  if(session.ownerUserId!==current.id&&current.role!=='admin')throw createError({statusCode:403,message:'上传归属权限已改变'})
  if(session.ownerUserId!==null){const owner=db.select().from(tables.users).where(eq(tables.users.id,session.ownerUserId)).get();if(owner?.status!=='active')throw createError({statusCode:409,message:'上传所有者已停用'})}
  return current
}

export function uploadDto(id:string,actor:Actor,db=useDB()) {
  const row=db.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()
  if(!row || !actor.user || (!actor.isAdmin && row.actorUserId!==actor.user.id))throw createError({statusCode:404,message:'Upload not found'})
  const parts=db.select().from(tables.uploadParts).where(eq(tables.uploadParts.sessionId,id)).all()
  const photo=row.photoId?db.select({status:tables.photos.processingStatus,errorCode:tables.photos.processingErrorCode}).from(tables.photos).where(and(eq(tables.photos.id,row.photoId),actor.isAdmin?undefined:eq(tables.photos.ownerId,actor.user.id))).get():null
  return {id:row.id,photoId:row.photoId,state:row.state,expiresAt:row.expiresAt,taskId:row.commitTaskId,photo,parts:parts.map((p)=>({id:p.id,role:p.role,state:p.state,size:p.expectedBytes,filename:p.originalFilename,url:`/api/uploads/sessions/${row.id}/parts/${p.id}`}))}
}

export async function receiveUpload(event:H3Event,actor:Actor,id:string,partId:string) {
  const lease=randomId()
  const part=useDB().transaction((tx)=>{
    uploadActor(tx as any,actor)
    const session=tx.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()
    const p=tx.select().from(tables.uploadParts).where(and(eq(tables.uploadParts.id,partId),eq(tables.uploadParts.sessionId,id))).get()
    if(!session || session.actorUserId!==actor.user?.id || !p)throw createError({statusCode:404,message:'Upload not found'})
    sessionActor(tx as any,actor,session)
    if(!['created','uploading'].includes(session.state)||session.expiresAt.getTime()<=Date.now())throw createError({statusCode:409,message:'上传已结束或过期'})
    if(p.state==='uploaded')return p
    if(p.state==='receiving' && (p.leaseExpiresAt?.getTime()??0)>Date.now())throw createError({statusCode:409,message:'该文件正在上传'})
    const receiving=tx.select({count:sql<number>`count(*)`}).from(tables.uploadParts).innerJoin(tables.uploadSessions,eq(tables.uploadParts.sessionId,tables.uploadSessions.id)).where(and(eq(tables.uploadSessions.actorUserId,actor.user!.id),eq(tables.uploadParts.state,'receiving'),sql`${tables.uploadParts.leaseExpiresAt}>${Math.floor(Date.now()/1000)}`)).get()!.count
    if(receiving>=3)throw createError({statusCode:429,message:'每个账号最多同时传输 3 个文件'})
    tx.update(tables.uploadParts).set({state:'receiving',leaseToken:lease,leaseExpiresAt:new Date(Date.now()+1800000)}).where(eq(tables.uploadParts.id,partId)).run()
    tx.update(tables.uploadSessions).set({state:'uploading',updatedAt:new Date()}).where(eq(tables.uploadSessions.id,id)).run()
    return p
  },{behavior:'immediate'})
  if(part.state==='uploaded') {
    const checksum=createHash('sha256'); let size=0
    for await(const chunk of event.node.req){size+=chunk.length;if(size>part.expectedBytes)throw createError({statusCode:409,message:'重复上传的内容不同'});checksum.update(chunk)}
    if(size!==part.receivedBytes||checksum.digest('hex')!==part.checksumSha256)throw createError({statusCode:409,message:'重复上传的内容不同'})
    const session=useDB().select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()!
    sessionActor(useDB(),actor,session)
    if(!['created','uploading'].includes(session.state))throw createError({statusCode:409,message:'上传状态已改变'})
    return {uploaded:true}
  }
  const dir=path.resolve('data/.uploads',id)
  await fs.mkdir(dir,{recursive:true})
  const temp=path.join(dir,`${partId}.${lease}`)
  let size=0
  const hash=createHash('sha256')
  const meter=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;if(size>part.expectedBytes||size>MAX_BYTES)return callback(createError({statusCode:413,message:'文件大小超过声明值'}));hash.update(chunk);callback(null,chunk)}})
  const heartbeat=setInterval(()=>{
    try{
      uploadActor(useDB(),actor)
      const session=useDB().select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()
      if(!session||!['created','uploading'].includes(session.state)||session.expiresAt.getTime()<=Date.now())throw new Error('Upload cancelled or expired')
      sessionActor(useDB(),actor,session)
      const updated=useDB().update(tables.uploadParts).set({leaseExpiresAt:new Date(Date.now()+120000)}).where(and(eq(tables.uploadParts.id,partId),eq(tables.uploadParts.leaseToken,lease))).run()
      if(!updated.changes)throw new Error('Upload lease lost')
    }catch(error){meter.destroy(error as Error)}
  },10000)
  heartbeat.unref()
  try {
    await pipeline(event.node.req,meter,createWriteStream(temp,{flags:'wx',mode:0o600}))
    if(size!==part.expectedBytes)throw createError({statusCode:422,message:'上传大小与声明不一致'})
    const detected=await fileTypeFromFile(temp)
    if(!detected || (!detected.mime.startsWith('image/')&&!detected.mime.startsWith('video/')) || detected.mime==='image/svg+xml' || (part.role==='live_video'&&!detected.mime.startsWith('video/')) || (detected.mime.startsWith('image/')&&size>MAX_IMAGE_BYTES))throw createError({statusCode:422,message:'不支持的文件格式或图片过大'})
    const checksum=hash.digest('hex')
    useDB().transaction((tx)=>{
      uploadActor(tx as any,actor)
      const session=tx.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()!
      sessionActor(tx as any,actor,session)
      const current=tx.select().from(tables.uploadParts).where(eq(tables.uploadParts.id,partId)).get()!
      if(!['created','uploading'].includes(session.state)||session.expiresAt.getTime()<=Date.now()||current.leaseToken!==lease)throw createError({statusCode:409,message:'上传状态已改变'})
      // Only this lease's validated path becomes a durable staging locator.
      tx.update(tables.uploadParts).set({state:'uploaded',stagingKey:path.relative(process.cwd(),temp),receivedBytes:size,detectedMime:detected.mime,checksumSha256:checksum,leaseToken:null,leaseExpiresAt:null,updatedAt:new Date()}).where(eq(tables.uploadParts.id,partId)).run()
    },{behavior:'immediate'})
    return {uploaded:true}
  }catch(e){
    await fs.unlink(temp).catch(()=>{})
    useDB().update(tables.uploadParts).set({state:'pending',leaseToken:null,leaseExpiresAt:null}).where(and(eq(tables.uploadParts.id,partId),eq(tables.uploadParts.leaseToken,lease))).run()
    throw e
  }finally{clearInterval(heartbeat)}
}

export async function completeUpload(id:string,actor:Actor) {
  const claimed=useDB().transaction((tx)=>{
    uploadActor(tx as any,actor)
    const session=tx.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()
    if(!session||session.actorUserId!==actor.user?.id)throw createError({statusCode:404,message:'Upload not found'})
    sessionActor(tx as any,actor,session)
    if(!session.photoId)throw createError({statusCode:410,message:'Photo removed'})
    if(session.state==='committed')return {session,parts:[],committed:true}
    if(!['created','uploading','finalizing'].includes(session.state)||session.expiresAt.getTime()<Date.now())throw createError({statusCode:409,message:'Upload expired or cancelled'})
    const parts=tx.select().from(tables.uploadParts).where(eq(tables.uploadParts.sessionId,id)).all()
    if(parts.some((p)=>!['uploaded','promoted'].includes(p.state)))throw createError({statusCode:409,message:'文件尚未全部上传'})
    if(parts.some((p)=>(p.leaseExpiresAt?.getTime()??0)>Date.now()))throw createError({statusCode:409,message:'上传正在完成，请稍后查询'})
    const lease=randomId()
    tx.update(tables.uploadSessions).set({state:'finalizing',updatedAt:new Date()}).where(eq(tables.uploadSessions.id,id)).run()
    tx.update(tables.uploadParts).set({leaseToken:lease,leaseExpiresAt:new Date(Date.now()+1800000)}).where(eq(tables.uploadParts.sessionId,id)).run()
    return {session,parts,lease,committed:false}
  },{behavior:'immediate'})
  if(claimed.committed)return uploadDto(id,actor)
  const store=new FixedStore(claimed.session.storageProviderId)
  const heartbeat=setInterval(()=>{useDB().update(tables.uploadParts).set({leaseExpiresAt:new Date(Date.now()+120000)}).where(and(eq(tables.uploadParts.sessionId,id),eq(tables.uploadParts.leaseToken,claimed.lease!))).run()},10000)
  heartbeat.unref()
  try{
    for(const part of claimed.parts){
      uploadActor(useDB(),actor)
      const activeSession=useDB().select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()
      if(activeSession?.state!=='finalizing')throw createError({statusCode:409,message:'Upload state changed'})
      sessionActor(useDB(),actor,activeSession)
      if(part.state!=='promoted'){
        try{await store.createExclusive(part.finalKey,path.resolve(part.stagingKey),part.detectedMime!)}catch(e:any){
          if(e.code!=='EEXIST'&&e.$metadata?.httpStatusCode!==412)throw e
          if((await store.meta(part.finalKey))?.size!==part.receivedBytes || await store.checksum(part.finalKey)!==part.checksumSha256)throw createError({statusCode:409,message:'目标文件已存在，请取消并重新上传'})
        }
        const changed=useDB().update(tables.uploadParts).set({state:'promoted'}).where(and(eq(tables.uploadParts.id,part.id),eq(tables.uploadParts.leaseToken,claimed.lease!))).run()
        if(!changed.changes)throw createError({statusCode:409,message:'Upload lease lost'})
      }
    }
    useDB().transaction((tx)=>{
      const user=uploadActor(tx as any,actor)
      const session=tx.select().from(tables.uploadSessions).where(eq(tables.uploadSessions.id,id)).get()!
      sessionActor(tx as any,actor,session)
      if(session.state!=='finalizing')throw createError({statusCode:409,message:'Upload state changed'})
      const parts=tx.select().from(tables.uploadParts).where(eq(tables.uploadParts.sessionId,id)).all()
      if(parts.some((p)=>p.state!=='promoted'||p.leaseToken!==claimed.lease))throw createError({statusCode:409,message:'Upload lease lost'})
      const original=parts.find((p)=>p.role==='original')!
      if(parts.length>1&&!original.detectedMime?.startsWith('image/'))throw createError({statusCode:422,message:'动态照片必须由一张图片与一个配对视频组成'})
      for(const p of parts)tx.insert(tables.photoFiles).values({id:p.id,photoId:session.photoId!,role:p.role,locatorType:'provider',storageProviderId:session.storageProviderId,storageKey:p.finalKey,mimeType:p.detectedMime!,byteSize:p.receivedBytes,checksumSha256:p.checksumSha256,isBillableOriginal:session.ownerUserId!==null,originalFilename:p.originalFilename,uploadRelativePath:p.uploadRelativePath}).run()
      tx.update(tables.storagePathClaims).set({holderType:'file',holderId:session.photoId!}).where(and(eq(tables.storagePathClaims.holderType,'upload'),eq(tables.storagePathClaims.holderId,id))).run()
      if(session.ownerUserId!==null)tx.update(tables.userStorageUsage).set({usedBytes:sql`${tables.userStorageUsage.usedBytes}+${session.reservedBytes}`,reservedBytes:sql`${tables.userStorageUsage.reservedBytes}-${session.reservedBytes}`,updatedAt:new Date()}).where(eq(tables.userStorageUsage.userId,session.ownerUserId)).run()
      tx.update(tables.photos).set({processingStatus:'processing',originalBytes:parts.reduce((size,part)=>size+part.receivedBytes,0),contentChecksum:original.checksumSha256,fileSize:original.receivedBytes,type:original.detectedMime!.startsWith('video/')?'video':'image',isLivePhoto:parts.length>1?1:0,updatedAt:new Date()}).where(eq(tables.photos.id,session.photoId!)).run()
      const task=tx.insert(tables.pipelineQueue).values({payload:{type:'photo-process',photoId:session.photoId!,uploadSessionId:id},photoId:session.photoId,uploadSessionId:id,dedupeKey:`process:${session.photoId}`}).returning().get()!
      tx.update(tables.uploadSessions).set({state:'committed',reservedBytes:0,commitTaskId:task.id,updatedAt:new Date()}).where(eq(tables.uploadSessions.id,id)).run()
      tx.update(tables.uploadParts).set({leaseToken:null,leaseExpiresAt:null}).where(eq(tables.uploadParts.sessionId,id)).run()
      audit(tx as any,user.id,'photo.upload','photo',session.photoId!,{ownerId:session.ownerUserId,after:{bytes:parts.reduce((size,part)=>size+part.receivedBytes,0)}})
    },{behavior:'immediate'})
    for(const p of claimed.parts)await fs.unlink(path.resolve(p.stagingKey)).catch(()=>{})
    return uploadDto(id,actor)
  }catch(e){
    useDB().update(tables.uploadParts).set({leaseToken:null,leaseExpiresAt:null}).where(and(eq(tables.uploadParts.sessionId,id),eq(tables.uploadParts.leaseToken,claimed.lease!))).run()
    throw e
  }finally{clearInterval(heartbeat)}
}
