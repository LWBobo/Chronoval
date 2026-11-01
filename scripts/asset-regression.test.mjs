import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createSecurityRuntime } from './test-utils/security-runtime.mjs'
import * as tables from '../server/database/schema.ts'
import { resolveApiAccess } from '../server/utils/access-policy.ts'

let runtime, media
const bytes = Buffer.from('same-original-asset-bytes-0123456789')
const id = () => randomBytes(16).toString('hex')
const request = (url, options = {}) => fetch(runtime.origin + url, options)
async function photo(extra = {}, locator = 'library') {
  const photoId = id(), assetId = id(), relative = `clips/${photoId}.MOV`
  const key = `photos/.site/${relative}`
  await runtime.write(locator === 'library' ? `library/${relative}` : `storage/${key}`, bytes)
  const row = runtime.db.insert(tables.photos).values({ id: photoId, type: 'video', source: locator === 'library' ? 'library' : 'upload', ...(locator === 'library' ? { libraryId: 1, libraryMount: 'scan_1', libraryPath: relative } : {}), ...extra }).returning().get()
  runtime.db.insert(tables.photoFiles).values({ id: assetId, photoId, role: 'original', locatorType: locator, ...(locator === 'library' ? { libraryId: 1, libraryPath: relative } : { storageProviderId: 1, storageKey: key }), byteSize: bytes.length, mimeType: 'video/quicktime', originalFilename: 'original.MOV' }).run()
  return { ...row, assetId, key, url: `/api/assets/${assetId}` }
}
before(async () => {
  runtime = await createSecurityRuntime()
  media = await import('../server/services/media-files/index.ts')
  for (const [url, file, method = 'get'] of [
    ['/api/assets/:assetId', 'server/api/assets/[assetId].ts'],
    ['/api/assets/:assetId', 'server/api/assets/[assetId].ts', 'head'],
    ['/api/photos', 'server/api/photos/index.get.ts'],
    ['/api/system/settings/all', 'server/api/system/settings/all.get.ts'],
  ]) await runtime.mount(url, file, method)
})
after(async () => { await runtime?.close() })
beforeEach(async () => {
  runtime.sqlite.exec('PRAGMA foreign_keys=OFF')
  for (const { name } of runtime.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'photo_ocr_fts%'").all()) runtime.sqlite.exec(`DELETE FROM "${name}"`)
  runtime.sqlite.exec('DELETE FROM photo_ocr_fts; PRAGMA foreign_keys=ON')
  runtime.state.sessions.clear(); runtime.state.settings.clear()
  runtime.state.scanRoots = []
  for (const directory of ['storage', 'library']) { await rm(path.join(runtime.scratch, directory), { force: true, recursive: true }); await mkdir(path.join(runtime.scratch, directory)) }
  runtime.db.insert(tables.settingsStorageProviders).values({ id: 1, name: 'asset-storage', provider: 'local', config: { provider: 'local', basePath: path.join(runtime.scratch, 'storage'), baseUrl: '/storage', prefix: 'photos' } }).run()
  runtime.db.insert(tables.libraries).values({ id: 1, name: 'assets', rootPath: path.join(runtime.scratch, 'library') }).run()
  runtime.state.libraries = runtime.db.select().from(tables.libraries).all()
  runtime.db.insert(tables.users).values({ id: 1, username: 'admin', usernameKey: 'admin', email: 'admin@example.test', emailKey: 'admin@example.test', displayName: 'Administrator', role: 'admin', mustChangePassword: false, createdAt: new Date() }).run()
})

test('registered URLs are stable, opaque, filename-free, and have no query', async () => {
  const p = await photo()
  const result = media.withAssetUrls(p)
  assert.equal(result.originalUrl, p.url); assert.equal(media.withAssetUrls(p).originalUrl, p.url)
  assert.match(p.url, /^\/api\/assets\/[a-f0-9]{32}$/); assert.equal(/video|\.mp4|\.mov|\?/i.test(p.url), false)
  assert.equal(p.url.includes(Buffer.from(p.id).toString('hex')), false)
})

test('registry serialization preserves rows and selects distinct original and live components', async () => {
  const p = await photo({ type: 'image', isLivePhoto: 1 }), liveId = id()
  await runtime.write('storage/side.MOV', bytes)
  runtime.db.insert(tables.photoFiles).values({ id: liveId, photoId: p.id, role: 'live_video', locatorType: 'provider', storageProviderId: 1, storageKey: 'side.MOV', byteSize: bytes.length, mimeType: 'video/quicktime' }).run()
  const serialized = media.withAssetUrlsBatch([p])[0]
  assert.equal(serialized.originalUrl, p.url); assert.equal(serialized.livePhotoVideoUrl, `/api/assets/${liveId}`)
  assert.equal(p.originalUrl, undefined); assert.equal(serialized.downloadUrl, p.url)
})

test('read aliases stay public at the API boundary and write methods remain administrative', () => {
  const url = `/api/assets/${id()}`
  assert.equal(resolveApiAccess('GET', url), 'public'); assert.equal(resolveApiAccess('HEAD', url), 'public')
  for (const method of ['POST','PUT','DELETE']) assert.equal(resolveApiAccess(method, url), 'admin')
})

test('gallery returns registered asset IDs while unrelated settings remain unchanged', async () => {
  const p = await photo(), gallery = await request('/api/photos?gallery=1')
  assert.equal(gallery.status, 200); assert.equal((await gallery.json())[0].originalUrl, p.url)
  runtime.db.insert(tables.settings).values({ namespace: 'app', key: 'title', value: 'Unchanged', type: 'string', isPublic: true }).run()
  assert.equal((await (await request('/api/system/settings/all')).json()).data.app.title, 'Unchanged')
})

test('library assets return original bytes with Range and HEAD and recheck conditional requests', async () => {
  const p = await photo(), response = await request(p.url)
  assert.equal(response.status, 200); assert.equal(response.redirected, false); assert.equal(response.headers.get('location'), null)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  const range = await request(p.url, { headers: { Range: 'bytes=2-6' } })
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 2-6/${bytes.length}`)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2,7))
  const head = await request(p.url, { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0)
  runtime.db.update(tables.photos).set({ deletedAt: new Date() }).where(eq(tables.photos.id, p.id)).run()
  assert.equal((await request(p.url, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 404)
})

test('local storage and live sidecars preserve bytes and component selection', async () => {
  const p = await photo({}, 'provider'), liveId = id()
  await runtime.write('storage/live.MOV', bytes.subarray(3))
  runtime.db.insert(tables.photoFiles).values({ id: liveId, photoId: p.id, role: 'live_video', locatorType: 'provider', storageProviderId: 1, storageKey: 'live.MOV', byteSize: bytes.length-3, mimeType: 'video/quicktime' }).run()
  assert.deepEqual(Buffer.from(await (await request(p.url)).arrayBuffer()), bytes)
  assert.deepEqual(Buffer.from(await (await request(`/api/assets/${liveId}`)).arrayBuffer()), bytes.subarray(3))
})

test('embedded clips retain relative ranges and never return the image prefix', async () => {
  const p = await photo({ type: 'image', isLivePhoto: 1 }), liveId = id(), offset = 10
  runtime.db.insert(tables.photoFiles).values({ id: liveId, photoId: p.id, role: 'live_video', locatorType: 'embedded', parentFileId: p.assetId, byteOffset: offset, byteLength: bytes.length-offset, byteSize: bytes.length-offset, mimeType: 'video/mp4' }).run()
  const url = `/api/assets/${liveId}`, full = await request(url)
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes.subarray(offset))
  const suffix = await request(url, { headers: { Range: 'bytes=-4' } })
  assert.equal(suffix.status, 206); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-4))
  assert.equal((await request(url, { headers: { Range: 'bytes=9999-' } })).status, 416)
})

test('fixed provider selection cannot change with the active default or use an arbitrary HTTP fallback', async () => {
  const p = await photo({}, 'provider')
  runtime.state.provider = { config: { provider: 'local', basePath: '/unrelated-provider' }, get: () => { throw new Error('Global default must not be used') } }
  assert.deepEqual(Buffer.from(await (await request(p.url, { headers: { Cookie: 'unrelated=secret' } })).arrayBuffer()), bytes)
  runtime.db.update(tables.photoFiles).set({ state: 'staging' }).where(eq(tables.photoFiles.id, p.assetId)).run()
  assert.equal((await request(p.url)).status, 404)
})

test('asset IDs never bypass album audience or password restrictions', async () => {
  const p = await photo()
  const album = runtime.db.insert(tables.collections).values({ kind: 'manual', title: 'restricted', uid: id(), visibility: 'admin', passwordHash: 'locked' }).returning().get()
  runtime.db.insert(tables.collectionPhotos).values({ collectionId: album.id, photoId: p.id }).run()
  assert.equal((await request(p.url)).status, 404)
  assert.equal((await request(p.url, { headers: { Cookie: 'test_session=1' } })).status, 200)
  runtime.db.update(tables.collections).set({ visibility: 'public' }).where(eq(tables.collections.id, album.id)).run()
  assert.equal((await request(p.url)).status, 404)
})

test('missing, malformed, deleted and unregistered component IDs are denied', async () => {
  for (const value of ['0ff', 'abc', '0'+Buffer.from('old-photo-id').toString('hex'), id()]) assert.equal((await request(`/api/assets/${value}`)).status, 404)
  const p = await photo({ deletedAt: new Date() })
  assert.equal((await request(p.url)).status, 404)
})
