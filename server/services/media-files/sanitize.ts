import { and, eq } from 'drizzle-orm'
import { promises as fs, createWriteStream, createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { tables, useDB } from '../../utils/db'
import { registeredFile, registeredFileStream, registeredFileBuffer } from './read'
import { FixedStore, randomId } from './store'
import { settingsManager } from '../settings/settingsManager'
import { preprocessImageBuffer } from '../image/processor'
import { FFMPEG_BIN } from '../library/ffmpeg'

/** Publish a separate location-free download; never rewrite original bytes. */
export async function sanitizePhotoLocation(photoId: string) {
  const db=useDB()
  const photo=db.transaction(tx=>{
    const row=tx.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
    if(!row || row.deletedAt || row.transferState!=='idle' || !['ready','failed'].includes(row.processingStatus))throw new Error('Photo unavailable for sanitization')
    tx.update(tables.photos).set({stripLocation:true,processingStatus:'processing',aclVersion:row.aclVersion+(row.stripLocation?0:1),updatedAt:new Date()}).where(eq(tables.photos.id,photoId)).run()
    return row
  },{behavior:'immediate'})
  let dir: string | undefined
  try{
    dir=await fs.mkdtemp(path.join(tmpdir(),'chronoval-safe-copy-'))
    const original=registeredFile(photoId,'original')
    if(!original)throw new Error('Original missing')
    const providerId=original.storageProviderId??(await settingsManager.storage.getActiveProvider())?.id
    if(!providerId)throw new Error('Storage unavailable')
    const store=new FixedStore(providerId),safe=registeredFile(photoId,'sanitized_download')
    if(!safe){
      const output=path.join(dir,photo.type==='video'?'download.mp4':'download.jpeg')
      if(photo.type==='video'){
        const source=path.join(dir,'source')
        await pipeline(await registeredFileStream(original),createWriteStream(source,{flags:'wx'}))
        // Drop global, chapter and stream metadata, subtitles and data tracks.
        await promisify(execFile)(FFMPEG_BIN,['-v','error','-i',source,'-map','0:v:0','-map','0:a?','-map_metadata','-1','-map_metadata:s','-1','-map_chapters','-1','-c','copy','-metadata','location=','-metadata','location-eng=','-movflags','+faststart',output],{timeout:120000,maxBuffer:1024*1024})
      }else{
        const raw=await registeredFileBuffer(photoId,['original'])
        const frame=await preprocessImageBuffer(raw,original.originalFilename||'')
        await sharp(frame,{limitInputPixels:100_000_000}).rotate().jpeg({quality:95}).toFile(output)
      }
      const digest=createHash('sha256')
      for await(const chunk of createReadStream(output))digest.update(chunk)
      const checksum=digest.digest('hex'),size=(await fs.stat(output)).size
      const owner=photo.ownerId?db.select().from(tables.users).where(eq(tables.users.id,photo.ownerId)).get():null
      const key=`${owner?`${store.userRoot(owner.username)}/.chronoval/${photoId}`:`${store.siteRoot(photoId)}/.chronoval`}/sanitized-${original.contentVersion}.${photo.type==='video'?'mp4':'jpeg'}`
      const mime=photo.type==='video'?'video/mp4':'image/jpeg'
      const record=db.transaction(tx=>{
        const current=tx.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
        if(!current||current.transferState!=='idle'||current.ownerId!==photo.ownerId||current.processingStatus!=='processing')throw new Error('Photo changed')
        const prior=tx.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId,photoId),eq(tables.photoFiles.role,'sanitized_download'))).get()
        if(prior){if(prior.storageKey!==key||prior.checksumSha256!==checksum)throw new Error('Safe copy conflict');return prior}
        return tx.insert(tables.photoFiles).values({id:randomId(),photoId,role:'sanitized_download',locatorType:'provider',storageProviderId:providerId,storageKey:key,mimeType:mime,byteSize:size,checksumSha256:checksum,state:'staging'}).returning().get()!
      },{behavior:'immediate'})
      try{await store.createExclusive(key,output,mime)}catch(error:any){
        if(error.code!=='EEXIST'&&error.$metadata?.httpStatusCode!==412)throw error
        if(await store.checksum(key)!==checksum)throw new Error('Safe copy checksum mismatch')
      }
      db.update(tables.photoFiles).set({state:'ready'}).where(eq(tables.photoFiles.id,record.id)).run()
    }
    db.transaction(tx=>{
      const current=tx.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
      if(!current||current.transferState!=='idle'||current.ownerId!==photo.ownerId||current.processingStatus!=='processing')throw new Error('Photo changed')
      const exif={...current.exif}
      for(const key of Object.keys(exif))if(/^GPS|location/i.test(key))delete (exif as Record<string,unknown>)[key]
      tx.update(tables.photos).set({processingStatus:'ready',processingErrorCode:null,latitude:null,longitude:null,country:null,city:null,locationName:null,exif:exif as typeof current.exif,metadataVersion:current.metadataVersion+1,updatedAt:new Date()}).where(eq(tables.photos.id,photoId)).run()
    },{behavior:'immediate'})
  }catch(error){
    db.update(tables.photos).set({processingStatus:'failed',processingErrorCode:'SAFE_COPY_FAILED'}).where(and(eq(tables.photos.id,photoId),eq(tables.photos.transferState,'idle'),eq(tables.photos.processingStatus,'processing'))).run()
    throw error
  }finally{if(dir)await fs.rm(dir,{recursive:true,force:true})}
}
