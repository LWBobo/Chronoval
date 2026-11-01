import { eq, and } from 'drizzle-orm'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { tables, useDB } from '../../utils/db'
import { FixedStore, randomId } from '../media-files/store'
import { preprocessImageBuffer } from '../image/processor'
import { extractExifData, extractPhotoInfo } from '../image/exif'
import { parseGPSCoordinates } from '../location/geocoding'
import { locateEmbeddedMotionVideo } from '../video/motion-photo'
import { probeVideo, extractVideoFrame } from '../library/ffmpeg'
import { MAX_IMAGE_BYTES } from './limits'

let processing = false
export function acquireUploadProcessor() { if (processing) return false; processing = true; return true }
export function releaseUploadProcessor() { processing = false }

export async function processUploadedPhoto(photoId: string) {
  const db = useDB()
  const photo = db.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
  if (!photo || photo.processingStatus !== 'processing') return
  if (photo.processingErrorCode === 'DERIVATIVE_CLEANUP') return
  if (photo.deletedAt) {
    db.update(tables.photos).set({ processingStatus: 'failed', processingErrorCode: 'TRASHED_BEFORE_PROCESSING' }).where(and(eq(tables.photos.id, photoId), eq(tables.photos.processingStatus, 'processing'))).run()
    return
  }
  if (photo.transferState !== 'idle') throw new Error('Photo transfer is in progress')
  const owner = photo.ownerId ? db.select().from(tables.users).where(eq(tables.users.id,photo.ownerId)).get() : null
  if (photo.ownershipType==='user' && (!owner || owner.status !== 'active')) {
    db.update(tables.photos).set({processingStatus:'failed',processingErrorCode:'OWNER_INACTIVE',updatedAt:new Date()}).where(and(eq(tables.photos.id,photoId),eq(tables.photos.processingStatus,'processing'))).run()
    return
  }
  const ownerId = photo.ownerId
  const original = db.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId,photoId),eq(tables.photoFiles.role,'original'),eq(tables.photoFiles.state,'ready'))).get()
  if (!original || original.locatorType !== 'provider') {db.update(tables.photos).set({processingStatus:'failed',processingErrorCode:'ORIGINAL_MISSING'}).where(eq(tables.photos.id,photoId)).run();throw new Error('Original file not found')}
  const storageProviderId = original.storageProviderId
  const store = new FixedStore(original.storageProviderId!)
  let dir = ''
  const derivedRoot = owner ? `${store.userRoot(owner.username)}/.chronoval/${photoId}` : `${store.siteRoot(photoId)}/.chronoval`
  async function derived(role: 'preview'|'thumbnail'|'poster'|'sanitized_download', filename: string, bytes: Buffer, mime: string) {
    const local = path.join(dir,filename), key = `${derivedRoot}/${filename}`
    await fs.writeFile(local,bytes,{flag:'wx'})
    const checksum = createHash('sha256').update(bytes).digest('hex')
    // Persist the locator before the external write. Failed jobs and crash recovery
    // therefore leave a complete file inventory for retry, transfer and purge.
    const record = db.transaction((tx) => {
      const current = tx.select().from(tables.photos).where(eq(tables.photos.id, photoId)).get()
      if (!current || current.processingStatus !== 'processing' || current.transferState !== 'idle' || current.ownerId !== ownerId) throw new Error('Photo state changed while processing')
      const existing = tx.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, photoId), eq(tables.photoFiles.role, role))).get()
      if (existing) {
        if (existing.storageKey !== key || existing.checksumSha256 !== checksum || !['staging', 'ready'].includes(existing.state)) throw new Error('Derived file registry conflict')
        return existing
      }
      return tx.insert(tables.photoFiles).values({ id: randomId(), photoId, role, locatorType: 'provider', storageProviderId, storageKey: key, byteSize: bytes.length, mimeType: mime, checksumSha256: checksum, state: 'staging' }).returning().get()!
    }, { behavior: 'immediate' })
    try { await store.createExclusive(key,local,mime) } catch(e:any) {
      if (e.code !== 'EEXIST' && e.$metadata?.httpStatusCode !== 412) throw e
      if (await store.checksum(key) !== checksum) throw new Error('Derived file conflict')
    }
    db.update(tables.photoFiles).set({ state: 'ready', updatedAt: new Date() }).where(and(eq(tables.photoFiles.id, record.id), eq(tables.photoFiles.state, 'staging'))).run()
    return record
  }
  try {
    dir = await fs.mkdtemp(path.join(tmpdir(),'chronoval-photo-'))
    let frame: Buffer, exif: Awaited<ReturnType<typeof extractExifData>> = null, raw: Buffer | null = null
    let videoDimensions: { width?: number; height?: number } | null = null
    if (photo.type === 'video') {
      let local = await store.localPath(original.storageKey!)
      if (!local) {
        local=path.join(dir,'source')
        const { pipeline } = await import('node:stream/promises')
        const { createWriteStream } = await import('node:fs')
        await pipeline(await store.read(original.storageKey!),createWriteStream(local,{flags:'wx'}))
      }
      const probe=await probeVideo(local)
      if (!probe?.hasVideo) throw new Error('Invalid video')
      videoDimensions = probe
      const image=await extractVideoFrame(local,probe.duration)
      if (!image) throw new Error('Video preview unavailable')
      frame=image
    } else {
      if(original.byteSize>MAX_IMAGE_BYTES)throw new Error('Image too large')
      const chunks:Buffer[]=[]
      for await (const chunk of await store.read(original.storageKey!)) chunks.push(Buffer.from(chunk))
      raw=Buffer.concat(chunks)
      frame=await preprocessImageBuffer(raw,original.originalFilename || '')
      exif=await extractExifData(frame,raw)
    }
    const image=sharp(frame,{limitInputPixels:100_000_000,animated:false}).rotate()
    const preview=await image.clone().resize({width:4096,height:4096,fit:'inside',withoutEnlargement:true}).jpeg({quality:92}).toBuffer()
    const thumbnail=await image.clone().resize({width:640,height:640,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer()
    const meta=await sharp(preview).metadata()
    await derived('preview','preview.jpeg',preview,'image/jpeg')
    await derived('thumbnail','thumbnail.webp',thumbnail,'image/webp')
    if(photo.stripLocation && photo.type==='image')await derived('sanitized_download','sanitized-download.jpeg',preview,'image/jpeg')
    const motion=raw && !photo.isLivePhoto ? locateEmbeddedMotionVideo(raw,exif) : null
    const info=extractPhotoInfo(original.originalFilename || '',exif)
    const coords = !photo.stripLocation && exif ? parseGPSCoordinates(exif) : null
    db.transaction((tx)=>{
      const current=tx.select().from(tables.photos).where(eq(tables.photos.id,photoId)).get()
      const active=ownerId?tx.select().from(tables.users).where(eq(tables.users.id,ownerId)).get():null
      if(!current||current.processingStatus==='purging'||current.transferState!=='idle'||current.ownerId!==ownerId||(ownerId&&active?.status!=='active'))throw new Error('Photo state changed while processing')
      if(motion)tx.insert(tables.photoFiles).values({id:randomId(),photoId,role:'live_video',locatorType:'embedded',parentFileId:original.id,byteOffset:motion.start,byteLength:original.byteSize-motion.start,byteSize:original.byteSize-motion.start,mimeType:'video/mp4'}).onConflictDoNothing().run()
      const width = videoDimensions?.width ?? meta.width
      const height = videoDimensions?.height ?? meta.height
      tx.update(tables.photos).set({processingStatus:'ready',processingErrorCode:null,title:current.metadataVersion===photo.metadataVersion?current.title || info.title:current.title,dateTaken:info.dateTaken,width,height,aspectRatio:width&&height?width/height:null,...(current.metadataVersion===photo.metadataVersion?{latitude:coords?.latitude??null,longitude:coords?.longitude??null}:{}),exif:photo.stripLocation?null:exif,tags:current.metadataVersion===photo.metadataVersion?info.tags:current.tags,isLivePhoto:motion?1:current.isLivePhoto,updatedAt:new Date()}).where(eq(tables.photos.id,photoId)).run()
    },{behavior:'immediate'})
    if(photo.stripLocation){const {sanitizePhotoLocation}=await import('../media-files/sanitize');await sanitizePhotoLocation(photoId)}
    const { enqueueMlJobsForPhoto }=await import('../ml/enqueue')
    await enqueueMlJobsForPhoto(photoId)
  } catch(e) {
    db.update(tables.photos).set({processingStatus:'failed',processingErrorCode:'MEDIA_PROCESSING_FAILED',updatedAt:new Date()}).where(and(eq(tables.photos.id,photoId),eq(tables.photos.transferState,'idle'),eq(tables.photos.processingStatus,'processing'))).run()
    throw e
  } finally { if(dir)await fs.rm(dir,{recursive:true,force:true}) }
}
