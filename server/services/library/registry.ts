import { and, eq } from 'drizzle-orm'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileTypeFromFile } from 'file-type'
import { tables, useDB } from '../../utils/db'
import { FixedStore, randomId } from '../media-files/store'
import { resolveInsideRoot } from '../../utils/safe-path'

export type ScannedPhoto = Partial<typeof tables.photos.$inferInsert> & {
  storageKey?: string | null; thumbnailKey?: string | null; originalUrl?: string | null
  thumbnailUrl?: string | null; livePhotoVideoKey?: string | null; livePhotoVideoUrl?: string | null
  fixedProviderId?: number
}

/** Freeze the indexed asset before any derivative is deleted or written. */
export async function beginScannedPhoto(id: string, libraryId: number, mount: string, relative: string, absolute: string, stat: Awaited<ReturnType<typeof fs.stat>>) {
  const detected = await fileTypeFromFile(absolute)
  const mime = detected?.mime ?? 'application/octet-stream'
  return useDB().transaction(tx => {
    const library = tx.select().from(tables.libraries).where(eq(tables.libraries.id, libraryId)).get()
    if (!library || !library.enabled || library.deleting) throw new Error('Library unavailable')
    const photo = tx.select().from(tables.photos).where(eq(tables.photos.id, id)).get()
    if (photo && (photo.deletedAt || photo.processingStatus === 'processing' || photo.processingStatus === 'purging' || photo.transferState !== 'idle')) throw new Error('Library asset is busy or in trash')
    const old = tx.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, id), eq(tables.photoFiles.role, 'original'))).get()
    const changed = !old || photo?.lastModified !== stat.mtime.toISOString() || old.byteSize !== stat.size
    if (photo) tx.update(tables.photos).set({ processingStatus: 'processing', processingErrorCode: null, updatedAt: new Date() }).where(eq(tables.photos.id, id)).run()
    else tx.insert(tables.photos).values({ id, source: 'library', libraryId, libraryMount: mount, libraryPath: relative, processingStatus: 'processing' }).run()
    const locator = { locatorType: 'library' as const, libraryId, libraryPath: relative, byteSize: Number(stat.size), mimeType: mime, originalFilename: path.posix.basename(relative), contentVersion: old ? old.contentVersion + (changed ? 1 : 0) : 1, state: 'ready' as const, updatedAt: new Date() }
    if (old) tx.update(tables.photoFiles).set(locator).where(eq(tables.photoFiles.id, old.id)).run()
    else tx.insert(tables.photoFiles).values({ id: randomId(), photoId: id, role: 'original', ...locator }).run()
    return { changed, stripLocation: photo?.stripLocation ?? false }
  }, { behavior: 'immediate' })
}

/** A durable locator exists before an external write, including on failed scans. */
export async function writeScannedDerivative(id: string, providerId: number, role: 'thumbnail' | 'preview', key: string, bytes: Buffer, mime: string) {
  const db = useDB(), store = new FixedStore(providerId)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const previous = db.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, id), eq(tables.photoFiles.role, role))).get()
  if (previous && (previous.storageProviderId !== providerId || previous.storageKey !== key || previous.checksumSha256 !== checksum)) {
    if (previous.locatorType !== 'provider') throw new Error('Invalid scan derivative')
    await new FixedStore(previous.storageProviderId!).remove(previous.storageKey!)
  }
  const file = db.transaction(tx => {
    const photo = tx.select().from(tables.photos).where(eq(tables.photos.id, id)).get()
    if (!photo || photo.processingStatus !== 'processing' || photo.transferState !== 'idle') throw new Error('Scan state changed')
    const data = { locatorType: 'provider' as const, storageProviderId: providerId, storageKey: key, byteSize: bytes.length, mimeType: mime, checksumSha256: checksum, state: 'staging' as const, contentVersion: (previous?.contentVersion ?? 0) + 1, updatedAt: new Date() }
    return previous
      ? tx.update(tables.photoFiles).set(data).where(eq(tables.photoFiles.id, previous.id)).returning().get()!
      : tx.insert(tables.photoFiles).values({ id: randomId(), photoId: id, role, ...data }).returning().get()!
  }, { behavior: 'immediate' })
  let dir: string | undefined
  try {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'chronoval-scan-'))
    const temp = path.join(dir, 'derivative')
    await fs.writeFile(temp, bytes, { flag: 'wx' })
    try { await store.createExclusive(key, temp, mime) } catch (error: any) {
      if (error.code !== 'EEXIST' && error.$metadata?.httpStatusCode !== 412) throw error
      if (await store.checksum(key) !== checksum) throw new Error('Scan derivative collision')
    }
    db.update(tables.photoFiles).set({ state: 'ready' }).where(eq(tables.photoFiles.id, file.id)).run()
  } finally { if (dir) await fs.rm(dir, { recursive: true, force: true }) }
  return file
}

export async function invalidateScannedSafeCopy(id: string) {
  const db = useDB()
  const safe = db.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, id), eq(tables.photoFiles.role, 'sanitized_download'))).get()
  if (!safe) return
  if (safe.locatorType !== 'provider') throw new Error('Invalid safe copy')
  await new FixedStore(safe.storageProviderId!).remove(safe.storageKey!)
  db.delete(tables.photoFiles).where(eq(tables.photoFiles.id, safe.id)).run()
}

export async function persistScannedPhoto(id: string, entry: ScannedPhoto) {
  const { storageKey: _key, thumbnailKey: _thumbnail, originalUrl: _url, thumbnailUrl: _thumb, livePhotoVideoKey, livePhotoVideoUrl: _live, fixedProviderId: _provider, ...data } = entry
  const db = useDB()
  const library = data.libraryId ? db.select().from(tables.libraries).where(eq(tables.libraries.id, data.libraryId)).get() : null
  if (!library || !library.enabled || library.deleting || !data.libraryPath) throw new Error('Library removed or disabled during scan')
  const stat = await fs.stat(resolveInsideRoot(library.rootPath, data.libraryPath))
  if (stat.size !== data.fileSize || stat.mtime.toISOString() !== data.lastModified) throw new Error('Original changed during scan')
  let live: Omit<typeof tables.photoFiles.$inferInsert, 'id' | 'photoId'> | null = null
  if (livePhotoVideoKey?.startsWith('embedded:')) {
    const start = Number(livePhotoVideoKey.slice(9))
    if (!Number.isSafeInteger(start) || start < 0 || start >= stat.size) throw new Error('Invalid embedded region')
    live = { role: 'live_video', locatorType: 'embedded', byteOffset: start, byteLength: stat.size - start, byteSize: stat.size - start, mimeType: 'video/mp4' }
  } else if (livePhotoVideoKey && data.libraryMount && livePhotoVideoKey.startsWith(`${data.libraryMount}/`)) {
    const relative = livePhotoVideoKey.slice(data.libraryMount.length + 1)
    const size = (await fs.stat(resolveInsideRoot(library.rootPath, relative))).size
    live = { role: 'live_video', locatorType: 'library', libraryId: library.id, libraryPath: relative, byteSize: size, mimeType: (await fileTypeFromFile(resolveInsideRoot(library.rootPath, relative)))?.mime ?? 'video/quicktime', originalFilename: path.posix.basename(relative) }
  }
  if(live?.locatorType==='library'){
    const occupied=db.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.locatorType,'library'),eq(tables.photoFiles.libraryId,library.id),eq(tables.photoFiles.libraryPath,live.libraryPath!))).get()
    if(occupied&&occupied.photoId!==id){
      const obsolete=db.transaction(tx=>{
        const old=tx.select().from(tables.photos).where(eq(tables.photos.id,occupied.photoId)).get()
        if(!old||old.deletedAt||old.ownershipType!=='site'||old.source!=='library'||old.transferState!=='idle'||!['ready','failed'].includes(old.processingStatus))throw new Error('Paired video is busy or in trash')
        // Preserve every album restriction when a formerly standalone clip is paired.
        for(const member of tx.select().from(tables.collectionPhotos).where(eq(tables.collectionPhotos.photoId,old.id)).all())tx.insert(tables.collectionPhotos).values({collectionId:member.collectionId,photoId:id,position:member.position}).onConflictDoNothing().run()
        tx.update(tables.photos).set({deletedAt:old.deletedAt??new Date(),processingStatus:'purging',updatedAt:new Date()}).where(eq(tables.photos.id,old.id)).run()
        return old.id
      },{behavior:'immediate'})
      const {purgeRegisteredPhoto}=await import('../photo-management/purge')
      await purgeRegisteredPhoto(obsolete)
    }
  }
  db.transaction(tx => {
    const currentLibrary = tx.select().from(tables.libraries).where(eq(tables.libraries.id, library.id)).get()
    if (!currentLibrary?.enabled || currentLibrary.deleting || currentLibrary.rootPath !== library.rootPath) throw new Error('Library removed or disabled during scan')
    const photo = tx.select().from(tables.photos).where(eq(tables.photos.id, id)).get()
    if (!photo || photo.processingStatus !== 'processing' || photo.transferState !== 'idle' || photo.deletedAt) throw new Error('Scan state changed')
    if (photo.metadataVersion > 1) for (const key of ['title','description','tags','latitude','longitude','country','city','locationName'] as const) delete data[key]
    if (photo.stripLocation) Object.assign(data, { latitude: null, longitude: null, country: null, city: null, locationName: null, exif: null })
    const original = tx.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, id), eq(tables.photoFiles.role, 'original'))).get()!
    const previous = tx.select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId, id), eq(tables.photoFiles.role, 'live_video'))).get()
    if (live) {
      const locator = { storageProviderId: null, storageKey: null, libraryId: null, libraryPath: null, parentFileId: null, byteOffset: null, byteLength: null, ...live, ...(live.locatorType === 'embedded' ? { parentFileId: original.id } : {}) }
      if (previous) tx.update(tables.photoFiles).set({ ...locator, contentVersion: previous.contentVersion + 1, state: 'ready', updatedAt: new Date() }).where(eq(tables.photoFiles.id, previous.id)).run()
      else tx.insert(tables.photoFiles).values({ id: randomId(), photoId: id, ...locator }).run()
    } else if (previous) tx.delete(tables.photoFiles).where(eq(tables.photoFiles.id, previous.id)).run()
    tx.update(tables.photos).set({ ...data, processingStatus: 'ready', processingErrorCode: null, originalFilename: path.posix.basename(data.libraryPath!), updatedAt: new Date() }).where(eq(tables.photos.id, id)).run()
  }, { behavior: 'immediate' })
  const current = db.select().from(tables.photos).where(eq(tables.photos.id, id)).get()
  if (current?.stripLocation) { const { sanitizePhotoLocation } = await import('../media-files/sanitize'); await sanitizePhotoLocation(id) }
}
