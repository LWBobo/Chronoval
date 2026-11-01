import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { createSecurityRuntime } from './test-utils/security-runtime.mjs'
import * as t from '../server/database/schema.ts'

let rt, access, users, management, transfers, uploads, collections, passwords, deletion
const id = () => randomBytes(16).toString('hex')
// Fixed JPEG bytes: authorization tests do not depend on a native image decoder.
const bytes = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300'+ '01'.repeat(64) +'ffd9', 'hex')
const sha = value => createHash('sha256').update(value).digest('hex')
const row = (table, key, value) => rt.db.select().from(table).where(eq(key, value)).get()
const actor = userId => { const u = row(t.users, t.users.id, userId); return { user: toSessionUser(u), isAdmin: u.role === 'admin' } }
const post = body => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
async function request(url, userId = null, options = {}) {
  const { cookie, headers, ...rest } = options
  return fetch(rt.origin + url, { ...rest, headers: { Cookie: [`test_session=${userId ?? 'guest'}`, cookie].filter(Boolean).join('; '), Origin: rt.origin, 'x-csrf-token': 'test-csrf-token', ...headers } })
}
async function json(url, userId, options) { const res = await request(url, userId, options); assert.equal(res.status, 200, await res.clone().text()); return res.json() }
function album(kind = 'manual', extra = {}) { return rt.db.insert(t.collections).values({ kind, ...(kind === 'manual' ? { title: 'album', uid: id() } : {}), ...extra }).returning().get() }
function link(collectionId, photoId) { rt.db.insert(t.collectionPhotos).values({ collectionId, photoId }).run() }
async function photo(extra = {}, relative = `${id()}.jpg`) {
  const photoId = id(), assetId = id(), owner = extra.ownerId ? row(t.users, t.users.id, extra.ownerId) : null, library = extra.source === 'library'
  const key = library ? relative : `photos/${owner?.username ?? '.site'}/${relative}`
  await rt.write(`${library ? 'library' : 'storage'}/${key}`, bytes)
  const p = rt.db.insert(t.photos).values({ id: photoId, title: relative, ownershipType: owner ? 'user' : 'site', ownerId: owner?.id ?? null, visibility: owner ? 'private' : 'inherit', processingStatus: 'ready', originalFilename: path.posix.basename(relative), uploadRelativePath: relative, storageRelativePath: relative, originalBytes: bytes.length, fileSize: bytes.length, ...(library ? { libraryId: 1, libraryMount: 'scan_1', libraryPath: relative } : {}), latitude: 30, longitude: 110, ...extra }).returning().get()
  rt.db.insert(t.photoFiles).values({ id: assetId, photoId, role: 'original', locatorType: library ? 'library' : 'provider', ...(library ? { libraryId: 1, libraryPath: relative } : { storageProviderId: 1, storageKey: key }), byteSize: bytes.length, mimeType: 'image/jpeg', checksumSha256: sha(bytes), isBillableOriginal: !!owner, originalFilename: path.posix.basename(relative), uploadRelativePath: relative }).run()
  if (owner) {
    rt.db.update(t.userStorageUsage).set({ usedBytes: sql`${t.userStorageUsage.usedBytes}+${bytes.length}` }).where(eq(t.userStorageUsage.userId, owner.id)).run()
    rt.db.insert(t.storagePathClaims).values({ id: id(), storageProviderId: 1, storageKeyNormalized: key.toLowerCase(), holderType: 'file', holderId: photoId }).run()
  }
  return { ...p, assetId, key }
}
const policy = (collectionId, extra = {}) => ({ expectedAclVersion: row(t.collections, t.collections.id, collectionId).aclVersion, visibility: 'public', viewerIds: [], passwordAction: 'keep', passwordExemptMode: 'none', passwordExemptUserIds: [], reason: 'regression', ...extra })
async function unlock(collectionId, password, userId = null) { const res = await request(`/api/collections/${collectionId}/unlock`, userId, post({ password })); assert.equal(res.status, 200, await res.clone().text()); return res.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') }
function face(photoId, personId) { rt.db.insert(t.assetFaces).values({ id: id(), photoId, personId, x1: 0, y1: 0, x2: 1, y2: 1, imageWidth: 1, imageHeight: 1, score: 1 }).run() }

before(async () => {
  rt = await createSecurityRuntime()
  access = await import('../server/utils/photo-visibility.ts'); users = await import('../server/services/users/index.ts')
  management = await import('../server/services/photo-management/index.ts'); transfers = await import('../server/services/photo-management/transfer.ts')
  uploads = await import('../server/services/uploads/index.ts'); collections = await import('../server/services/collections/access.ts')
  passwords = await import('../server/utils/scanAlbumPassword.ts'); deletion = await import('../server/services/users/deletion.ts')
  for (const [route, file, method = 'get'] of [
    ['/api/assets/:assetId', 'server/api/assets/[assetId].ts'], ['/api/assets/:assetId', 'server/api/assets/[assetId].ts', 'head'],
    ['/storage/**', 'server/routes/storage/[...path].ts'], ['/library/**', 'server/routes/library/[...path].ts'],
    ['/api/photos', 'server/api/photos/index.get.ts'], ['/api/photos/visible', 'server/api/photos/visible.get.ts'], ['/api/map/photos', 'server/api/map/photos.get.ts'],
    ['/api/collections/:id/unlock', 'server/api/collections/[id]/unlock.post.ts', 'post'],
    ['/api/login', 'server/api/login.post.ts', 'post'], ['/api/me/profile', 'server/api/me/profile.get.ts'],
    ['/api/picker/photos', 'server/api/picker/photos.get.ts'],
    ['/api/me/recipients', 'server/api/me/recipients.get.ts'],
    ['/api/me/photos', 'server/api/me/photos/index.get.ts'],
    ['/api/admin/photos', 'server/api/admin/photos/index.get.ts'],
    ['/api/admin/users/:id', 'server/api/admin/users/[id]/index.get.ts'],
    ['/api/admin/users/:id/reconcile-storage', 'server/api/admin/users/[id]/reconcile-storage.post.ts', 'post'],
    ['/api/admin/audit-logs', 'server/api/admin/audit-logs.get.ts'],
    ['/api/me/photos/lifecycle-batch', 'server/api/me/photos/lifecycle-batch.post.ts', 'post'],
    ['/api/albums', 'server/api/albums/index.get.ts'],
    ['/api/albums/:albumId', 'server/api/albums/[albumId]/index.get.ts'],
    ['/api/albums/:albumId', 'server/api/albums/[albumId]/index.put.ts', 'put'],
    ['/api/albums/:albumId', 'server/api/albums/[albumId]/index.delete.ts', 'delete'],
    ['/api/albums/add-photos', 'server/api/albums/add-photos.post.ts', 'post'],
    ['/api/people/:id', 'server/api/people/[id].get.ts'],
    ['/api/photos/:photoId/faces', 'server/api/photos/[photoId]/faces.get.ts'],
    ['/api/auth/github', 'server/api/auth/github.get.ts'],
    ['/api/login/2fa', 'server/api/login/2fa.post.ts', 'post'],
    ['/api/system/settings/all', 'server/api/system/settings/all.get.ts'],
    ['/api/admin/photo-transfers/:id/retry', 'server/api/admin/photo-transfers/[id]/retry.post.ts', 'post'],

    ['/api/me/photos/visibility-batch', 'server/api/me/photos/visibility-batch.post.ts', 'post'],
    ['/api/admin/users', 'server/api/admin/users/index.post.ts', 'post'],
    ['/api/admin/collections/:id/access/preview', 'server/api/admin/collections/[id]/access/preview.post.ts', 'post'],
    ['/api/uploads/sessions/:id/parts/:partId', 'server/api/uploads/sessions/[id]/parts/[partId].put.ts', 'put'],
    ['/api/uploads/sessions/:id/complete', 'server/api/uploads/sessions/[id]/complete.post.ts', 'post'],
    ['/api/uploads/sessions', 'server/api/uploads/sessions/index.get.ts'],
    ['/api/uploads/sessions/:id', 'server/api/uploads/sessions/[id]/index.get.ts'],
  ]) await rt.mount(route, file, method)
})
after(async () => { await rt?.close() })
beforeEach(async () => {
  rt.sqlite.exec('PRAGMA foreign_keys=OFF')
  for (const { name } of rt.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'photo_ocr_fts%'").all()) rt.sqlite.exec(`DELETE FROM "${name}"`)
  rt.sqlite.exec('DELETE FROM photo_ocr_fts; PRAGMA foreign_keys=ON')
  rt.state.sessions.clear(); rt.state.settings.clear(); rt.state.settings.set('system:firstLaunch', false)
  rt.state.scanRoots = []; rt.state.loginAttempts = []
  for (const [userId, username, role] of [[1, 'administrator', 'admin'], [2, 'alice', 'user'], [3, 'bravo', 'user'], [4, 'charlie', 'user']]) {
    rt.db.insert(t.users).values({ id: userId, username, usernameKey: username, email: `${username}@test.invalid`, emailKey: `${username}@test.invalid`, displayName: username, password: 'hashed:secure-password', role, mustChangePassword: false, createdAt: new Date() }).run()
    rt.db.insert(t.userStorageUsage).values({ userId }).run()
  }
  for (const dir of ['storage', 'library']) { await rm(path.join(rt.scratch, dir), { recursive: true, force: true }); await mkdir(path.join(rt.scratch, dir)) }
  rt.db.insert(t.settingsStorageProviders).values({ id: 1, name: 'fixture', provider: 'local', config: { provider: 'local', basePath: path.join(rt.scratch, 'storage'), prefix: 'photos', baseUrl: '/storage' } }).run()
  rt.state.provider = { config: row(t.settingsStorageProviders, t.settingsStorageProviders.id, 1).config }
  rt.db.insert(t.libraries).values({ id: 1, name: 'fixture', rootPath: path.join(rt.scratch, 'library'), urlKey: 'fixture' }).run()
  rt.state.libraries = rt.db.select().from(t.libraries).all()
})

test('fresh schema enforces normalized unique immutable usernames and foreign keys', async () => {
  assert.equal(rt.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.throws(() => rt.db.update(t.users).set({ username: 'changed', usernameKey: 'changed' }).where(eq(t.users.id, 2)).run(), /immutable/)
  for (const username of ['CON', 'com1', 'a b', '../abc', 'abc.', '12abc']) assert.throws(() => users.createUserSchema.parse({ username, email: 'new@test.invalid' }))
  const input = users.createUserSchema.parse({ username: '  New_User  ', email: 'new@test.invalid' })
  const result = await users.createAccount(input, 1, 'user', actor(1))
  assert.equal(result.user.username, 'new_user'); assert.equal(result.initialPassword.length >= 12, true)
  assert.equal((await stat(path.join(rt.scratch, 'storage/photos/new_user'))).isDirectory(), true)
  await assert.rejects(users.createAccount(input, 1, 'user', actor(1)), e => e.statusCode === 409)
  assert.equal((await request('/api/admin/users', 2, post(input))).status, 403)
})

for (const visibility of ['private', 'public', 'shared']) test(`personal ${visibility}: SQL, media and explicit management context`, async () => {
  const p = await photo({ ownerId: 2, visibility })
  if (visibility === 'shared') rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 3, grantedBy: 2 }).run()
  for (const userId of [null, 1, 2, 3, 4]) {
    const expected = visibility === 'public' || userId === 2 || (visibility === 'shared' && userId === 3)
    const visible = rt.db.select({ id: t.photos.id }).from(t.photos).where(and(eq(t.photos.id, p.id), access.photoVisibleSql({ viewerRank: userId === 1 ? 2 : userId ? 1 : 0, userId, surface: 'discover', unlockedIds: [] }))).get()
    assert.equal(!!visible, expected, `SQL viewer ${userId}`)
    assert.equal((await request(`/api/assets/${p.assetId}`, userId)).status, userId === 1 || expected ? 200 : 404)
  }
  assert.equal((await json('/api/photos?manage=1', 1)).some(v => v.id === p.id), true)
  assert.equal((await request('/api/photos?manage=1', 2)).status, 403)
})

test('unauthorized or stale batches are atomic; receipt retries do not change versions twice', async () => {
  const a = await photo({ ownerId: 2 }), b = await photo({ ownerId: 3 })
  const batch = { operationId: id(), items: [{ id: a.id, expectedAclVersion: 1 }, { id: b.id, expectedAclVersion: 1 }], visibility: 'public', recipientIds: [] }
  assert.equal((await request('/api/me/photos/visibility-batch', 2, post(batch))).status, 404)
  assert.equal(row(t.photos, t.photos.id, a.id).visibility, 'private')
  batch.items = batch.items.slice(0, 1)
  const first = await json('/api/me/photos/visibility-batch', 2, post(batch))
  assert.deepEqual(await json('/api/me/photos/visibility-batch', 2, post(batch)), first)
  assert.equal(row(t.photos, t.photos.id, a.id).aclVersion, 2)
  batch.operationId = id(); assert.equal((await request('/api/me/photos/visibility-batch', 2, post(batch))).status, 409)
})

test('revocation affects opaque and encoded legacy aliases before HEAD, Range or conditional responses', async () => {
  const p = await photo({ ownerId: 2, visibility: 'shared' }, '中文 空格 %.jpg')
  rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 3, grantedBy: 2 }).run()
  const paths = [`/api/assets/${p.assetId}`, `/storage/${p.key.split('/').map(encodeURIComponent).join('/')}`]
  for (const url of paths) assert.equal((await request(url, 3)).status, 200)
  management.changePhotoVisibility(actor(2), p.id, { expectedAclVersion: 1, visibility: 'private', recipientIds: [] })
  for (const url of paths) for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=0-9', 'If-None-Match': 'old' } }]) assert.equal((await request(url, 3, options)).status, 404)
})

test('embedded Live Photo ranges stay inside the registered region and invalid IDs are rejected', async () => {
  const p = await photo(), live = id()
  rt.db.insert(t.photoFiles).values({ id: live, photoId: p.id, role: 'live_video', locatorType: 'embedded', parentFileId: p.assetId, byteOffset: 10, byteLength: 12, byteSize: 12, mimeType: 'video/mp4' }).run()
  const res = await request(`/api/assets/${live}`, null, { headers: { Range: 'bytes=2-5' } })
  assert.equal(res.status, 206); assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(12, 16))
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/12'); assert.equal(res.headers.get('cache-control'), 'private, no-store')
  assert.equal((await request(`/api/assets/${live}`, null, { headers: { Range: 'bytes=12-99' } })).status, 416)
  assert.equal([401, 404].includes((await request('/api/assets/video.mp4')).status), true)
  assert.throws(() => rt.db.update(t.photoFiles).set({ byteLength: bytes.length }).where(eq(t.photoFiles.id, live)).run(), /bounds/)
})

for (const kind of ['manual', 'folder', 'person']) test(`${kind}: selected audience, independent exemptions, password unlock and version conflict`, async () => {
  const c = album(kind, kind === 'folder' ? { libraryId: 1, relPath: '' } : {}), p = await photo(kind === 'folder' ? { source: 'library' } : {})
  if (kind === 'manual') link(c.id, p.id)
  if (kind === 'person') { rt.db.insert(t.people).values({ id: 'person', collectionId: c.id, name: 'person' }).run(); face(p.id, 'person') }
  collections.replaceCollectionPolicy(c.id, policy(c.id, { visibility: 'selected', viewerIds: [3], passwordAction: 'set', newPassword: 'album-pass', passwordExemptMode: 'selected', passwordExemptUserIds: [4] }), actor(1))
  assert.equal((await request(`/api/assets/${p.assetId}`, 3)).status, 404)
  assert.equal((await request(`/api/assets/${p.assetId}`, 4)).status, 404)
  const cookie = await unlock(c.id, 'album-pass', 3)
  assert.equal((await request(`/api/assets/${p.assetId}`, 3, { cookie })).status, 200)
  collections.replaceCollectionPolicy(c.id, policy(c.id, { visibility: 'login', passwordAction: 'clear' }), actor(1))
  assert.equal((await request(`/api/assets/${p.assetId}`)).status, 404); assert.equal((await request(`/api/assets/${p.assetId}`, 4)).status, 200)
  assert.throws(() => collections.replaceCollectionPolicy(c.id, policy(c.id, { expectedAclVersion: 1 }), actor(1)), e => e.statusCode === 409)
})

test('ancestor and multi-album audiences intersect; child public never widens its parent', async () => {
  const root = album('folder', { libraryId: 1, relPath: '', visibility: 'selected' })
  rt.db.insert(t.collectionViewers).values({ collectionId: root.id, userId: 3, grantedBy: 1 }).run()
  const child = album('folder', { libraryId: 1, parentId: root.id, relPath: 'child' }), p = await photo({ source: 'library' }, 'child/a.jpg'), m = album('manual', { visibility: 'selected' })
  rt.db.insert(t.collectionViewers).values({ collectionId: m.id, userId: 4, grantedBy: 1 }).run(); link(m.id, p.id)
  for (const viewer of [null, 2, 3, 4]) assert.equal((await request(`/api/assets/${p.assetId}`, viewer)).status, 404)
  rt.db.insert(t.collectionViewers).values({ collectionId: m.id, userId: 3, grantedBy: 1 }).run()
  assert.equal((await request(`/api/assets/${p.assetId}`, 3)).status, 200); assert.equal(collections.collectionAudienceAccess(child.id, actor(4)), false)
})

test('nearest password boundaries, Chinese sibling scopes and password versions are independent', async () => {
  const root = album('folder', { libraryId: 1, relPath: '', passwordHash: passwords.hashAlbumPassword('root') })
  album('folder', { libraryId: 1, parentId: root.id, relPath: '中文' })
  const b = album('folder', { libraryId: 1, parentId: root.id, relPath: '中文2', passwordHash: passwords.hashAlbumPassword('child') })
  const pa = await photo({ source: 'library' }, '中文/a %.jpg'), pb = await photo({ source: 'library' }, '中文2/b.jpg'), cookie = await unlock(root.id, 'root')
  assert.equal((await request(`/api/assets/${pa.assetId}`, null, { cookie })).status, 200); assert.equal((await request(`/api/assets/${pb.assetId}`, null, { cookie })).status, 404)
  const childCookie = await unlock(b.id, 'child')
  assert.equal((await request(`/api/assets/${pb.assetId}`, null, { cookie: childCookie })).status, 200); assert.equal((await request(`/api/assets/${pa.assetId}`, null, { cookie: childCookie })).status, 404)
  collections.replaceCollectionPolicy(root.id, policy(root.id, { passwordAction: 'set', newPassword: 'root' }), actor(1))
  assert.equal((await request(`/api/assets/${pa.assetId}`, null, { cookie })).status, 404)
  assert.equal((await json('/api/photos?gallery=1')).some(p => p.id === pa.id), false)
})

test('Chinese, spaces and literal percent library aliases work; disabled libraries, trash and traversal are rejected', async () => {
  album('folder', { libraryId: 1, relPath: '' })
  const rel = '中文/空 格%25.jpg', p = await photo({ source: 'library' }, rel), url = `/library/scan_1/${rel.split('/').map(encodeURIComponent).join('/')}`
  assert.equal((await request(url)).status, 200)
  rt.db.update(t.libraries).set({ enabled: false }).where(eq(t.libraries.id, 1)).run(); assert.equal((await request(url)).status, 404)
  rt.db.update(t.libraries).set({ enabled: true }).where(eq(t.libraries.id, 1)).run(); rt.db.update(t.photos).set({ deletedAt: new Date() }).where(eq(t.photos.id, p.id)).run()
  assert.equal((await request(url)).status, 404); assert.equal((await request(`/api/assets/${p.assetId}`, 1)).status, 200)
  for (const unsafe of ['/library/scan_1/%2e%2e%2foutside', '/library/scan_1/%252e%252e%252foutside', '/storage/%2e%2e%2foutside']) assert.notEqual((await request(unsafe)).status, 200)
})

test('private location originals are available only to owner/admin', async () => {
  const p = await photo({ ownerId: 2, visibility: 'public', stripLocation: true })
  assert.equal((await request(`/api/assets/${p.assetId}`)).status, 404); assert.equal((await request(`/api/assets/${p.assetId}`, 2)).status, 200)
  const dto = toPublicPhoto({ ...p, exif: { GPSLatitude: 30, Location: 'hidden' } })
  assert.equal(dto.latitude, null); assert.equal(dto.exif?.GPSLatitude, undefined)
})

test('transfer moves originals, keeps asset IDs, removes old person/share access and conserves quota', async () => {
  const p = await photo({ ownerId: 2, visibility: 'shared' }, '目录/原照片.jpg'), c = album('person', { ownershipType: 'user', ownerId: 2, visibility: 'admin' })
  rt.db.insert(t.people).values({ id: 'person', collectionId: c.id, ownershipType: 'user', ownerId: 2, name: 'old', origin: 'manual' }).run(); face(p.id, 'person')
  const other = await photo({ ownerId: 3 }); assert.throws(() => face(other.id, 'person'), /partition/)
  assert.throws(() => rt.db.update(t.photos).set({ ownerId: 3 }).where(eq(t.photos.id, p.id)).run(), /associations/)
  rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 4, grantedBy: 2 }).run()
  const input = { toUserId: 3, expectedAclVersion: 1, idempotencyKey: id(), reason: 'transfer' }, task = await transfers.startOwnershipTransfer(actor(1), p.id, input)
  assert.equal((await request(`/api/assets/${p.assetId}`, 2)).status, 404); await transfers.processOwnershipTransfer(task.id)
  const moved = row(t.photos, t.photos.id, p.id), file = row(t.photoFiles, t.photoFiles.id, p.assetId)
  assert.equal(moved.ownerId, 3); assert.equal(moved.visibility, 'private'); assert.equal(moved.transferState, 'idle'); assert.equal(file.storageKey, 'photos/bravo/目录/原照片.jpg')
  await assert.rejects(stat(path.join(rt.scratch, 'storage', p.key)), /ENOENT/)
  assert.equal((await request(`/api/assets/${p.assetId}`, 3)).status, 200); assert.equal((await request(`/api/assets/${p.assetId}`, 2)).status, 404)
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).usedBytes, 0); assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 3).usedBytes, bytes.length * 2)
  assert.equal(row(t.people, t.people.id, 'person').faceCount, 0); assert.equal((await transfers.startOwnershipTransfer(actor(1), p.id, input)).id, task.id)
})

test('same-name transfer uses a separate directory; failed copy rolls back quota and ownership', async () => {
  const p = await photo({ ownerId: 2 }, 'same.jpg'); await photo({ ownerId: 3 }, 'same.jpg')
  const start = p => transfers.startOwnershipTransfer(actor(1), p.id, { toUserId: 3, expectedAclVersion: 1, idempotencyKey: id(), reason: 'collision' })
  let task = await start(p); await transfers.processOwnershipTransfer(task.id)
  assert.equal(row(t.photoFiles, t.photoFiles.id, p.assetId).storageKey, `photos/bravo/_duplicates/${p.id}/same.jpg`)
  const q = await photo({ ownerId: 2 }, 'missing.jpg'); task = await start(q); await rm(path.join(rt.scratch, 'storage', q.key))
  await assert.rejects(transfers.processOwnershipTransfer(task.id)); assert.equal(transfers.transferDto(task.id).state, 'failed')
  assert.equal(row(t.photos, t.photos.id, q.id).ownerId, 2); assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 3).reservedBytes, 0)
})

test('upload reserves once, preserves path and bytes, commits quota once, and isolates same-name uploads', async () => {
  const input = uploads.uploadInputSchema.parse({ idempotencyKey: id(), visibility: 'private', parts: [{ role: 'original', relativePath: '相片/原 照片%.jpg', size: bytes.length, mime: 'image/jpeg' }] })
  const session = await uploads.initializeUpload(actor(2), input)
  assert.equal((await uploads.initializeUpload(actor(2), input)).id, session.id); assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).reservedBytes, bytes.length)
  const res = await request(session.parts[0].url, 2, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'image/jpeg' } }); assert.equal(res.status, 200, await res.text())
  const completed = await json(`/api/uploads/sessions/${session.id}/complete`, 2, post({})); assert.equal(completed.state, 'committed')
  const original = rt.db.select().from(t.photoFiles).where(eq(t.photoFiles.photoId, completed.photoId)).get()
  assert.equal(original.storageKey, 'photos/alice/相片/原 照片%.jpg'); assert.equal(original.checksumSha256, sha(bytes))
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).reservedBytes, 0); assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).usedBytes, bytes.length)
  const duplicate = await uploads.initializeUpload(actor(2), { ...input, idempotencyKey: id() })
  assert.match(row(t.uploadParts, t.uploadParts.sessionId, duplicate.id).finalKey, /_duplicates\//)
  const { cancelUpload } = await import('../server/services/uploads/cleanup.ts'); await cancelUpload(duplicate.id, actor(2))
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).reservedBytes, 0)
})

test('quota limits and unsafe upload paths reject without reservations', async () => {
  rt.db.update(t.users).set({ storageQuotaBytes: 1 }).where(eq(t.users.id, 2)).run()
  const input = uploads.uploadInputSchema.parse({ idempotencyKey: id(), parts: [{ role: 'original', relativePath: 'original.jpg', size: bytes.length }] })
  await assert.rejects(uploads.initializeUpload(actor(2), input), e => e.statusCode === 409)
  for (const relativePath of ['../photo.jpg', '/photo.jpg', 'a\\b.jpg', '.chronoval/x.jpg', 'con.jpg']) await assert.rejects(uploads.initializeUpload(actor(2), { ...input, parts: [{ ...input.parts[0], relativePath }] }))
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).reservedBytes, 0)
})

test('preview rolls back real policy, versions and audit records', async () => {
  const c = album(), p = await photo(); link(c.id, p.id)
  const version = row(t.collections, t.collections.id, c.id).aclVersion, count = rt.db.select().from(t.auditLogs).all().length
  const result = await json(`/api/admin/collections/${c.id}/access/preview`, 1, post({ access: policy(c.id, { visibility: 'selected', viewerIds: [3] }), userId: 4, context: 'front' }))
  assert.equal(result.canEnterAudience, false); assert.equal(result.visibleCount, 0); assert.equal(row(t.collections, t.collections.id, c.id).aclVersion, version); assert.equal(rt.db.select().from(t.auditLogs).all().length, count)
  assert.equal(result.blockReasons.collections, 1); assert.equal(result.blockReasons.otherCollections, 0)
  const other = album('manual', { visibility: 'admin' }); link(other.id, p.id)
  const blocked = await json(`/api/admin/collections/${c.id}/access/preview`, 1, post({ access: policy(c.id, { visibility: 'public' }), userId: 4, context: 'front' }))
  assert.equal(blocked.canEnterAudience, true); assert.equal(blocked.visibleCount, 0); assert.equal(blocked.blockReasons.otherCollections, 1)
})

test('revoked sessions are rejected and the last administrator is protected', async () => {
  assert.equal((await request('/api/me/profile', 2)).status, 200)
  rt.db.update(t.users).set({ status: 'disabled', authVersion: 2 }).where(eq(t.users.id, 2)).run(); assert.equal((await request('/api/me/profile', 2)).status, 401)
  assert.throws(() => users.assertNotLastAdmin(rt.db, row(t.users, t.users.id, 1)), e => e.statusCode === 409)
  assert.throws(() => deletion.startUserDeletion(actor(1), 1, { expectedVersion: 1, mode: 'purge', idempotencyKey: id(), reason: 'last admin' }), e => e.statusCode === 409)
})

test('username/email login use one account; invalid CSRF and foreign Origin reject writes', async () => {
  for (const identifier of ['ALICE', 'ALICE@TEST.INVALID']) { const res = await request('/api/login', null, post({ identifier, password: 'secure-password' })); assert.equal(res.status, 201, await res.text()); rt.state.sessions.delete('guest') }
  for (const headers of [{ 'x-csrf-token': 'wrong' }, { Origin: 'https://foreign.invalid' }]) assert.equal((await request('/api/login', null, { ...post({ identifier: 'alice', password: 'secure-password' }), headers: { 'Content-Type': 'application/json', ...headers } })).status, 403)
})

test('deletion tombstones only after cleanup; active and completed deletion tasks cannot be reset', async () => {
  const task = deletion.startUserDeletion(actor(1), 2, { expectedVersion: 1, mode: 'purge', idempotencyKey: id(), reason: 'delete' })
  assert.throws(() => deletion.retryUserDeletion(actor(1), task.id, 'retry'), e => e.statusCode === 409)
  assert.equal(await deletion.processUserDeletion(2), true); assert.equal(deletion.deletionDto(task.id).state, 'completed'); assert.equal(row(t.users, t.users.id, 2).status, 'deleted')
})

test('picker is admin-only and paginates deterministically', async () => {
  const c = album(); for (let index = 0; index < 5; index++) await photo()
  assert.equal((await request(`/api/picker/photos?collectionId=${c.id}`, 2)).status, 403)
  const a = await json(`/api/picker/photos?collectionId=${c.id}&limit=2`, 1), b = await json(`/api/picker/photos?collectionId=${c.id}&limit=2&cursor=${encodeURIComponent(a.nextCursor)}`, 1)
  assert.equal(a.items.length, 2); assert.equal(b.items.length, 2); assert.equal(a.items.some(v => b.items.some(w => v.id === w.id)), false)
})


test('transfer cleanup failures preserve cutover, stable media IDs and exclusive new ownership', async () => {
  const p = await photo({ ownerId: 2, visibility: 'shared' }, '照片/keep.jpg')
  rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 4, grantedBy: 2 }).run()
  const c = album('person', { ownershipType: 'user', ownerId: 2, visibility: 'admin' })
  rt.db.insert(t.people).values({ id: 'old-owner-person', name: 'private-name', collectionId: c.id, ownershipType: 'user', ownerId: 2 }).run()
  face(p.id, 'old-owner-person')
  const task = await transfers.startOwnershipTransfer(actor(1), p.id, { toUserId: 3, expectedAclVersion: 1, idempotencyKey: id(), reason: 'transfer' })
  const { FixedStore } = await import('../server/services/media-files/store.ts'), remove = FixedStore.prototype.remove
  FixedStore.prototype.remove = async function(key) { if (key.startsWith('photos/alice/')) throw new Error('injected source cleanup failure'); return remove.call(this, key) }
  try { await assert.rejects(transfers.processOwnershipTransfer(task.id), /cleanup failure/) } finally { FixedStore.prototype.remove = remove }
  const current = row(t.photos, t.photos.id, p.id)
  assert.equal(current.ownerId, 3); assert.equal(current.visibility, 'private'); assert.equal(current.transferState, 'cleanup_pending')
  assert.equal(rt.db.select().from(t.photoShares).all().length, 0); assert.equal(rt.db.select().from(t.assetFaces).all().length, 0)
  assert.equal((await request(`/api/assets/${p.assetId}`, 2)).status, 404); assert.equal((await request(`/api/assets/${p.assetId}`, 4)).status, 404)
  assert.equal((await request(`/api/assets/${p.assetId}`, 3)).status, 200)
  management.editPhotoMetadata(actor(3), p.id, { expectedVersion: current.metadataVersion, title: 'new owner' })
  assert.throws(() => management.changePhotoVisibility(actor(3), p.id, { expectedAclVersion: current.aclVersion, visibility: 'public', recipientIds: [] }), e => e.statusCode === 409)
  assert.equal((await request(`/api/admin/photo-transfers/${task.id}/retry`, 3, post({ reason: 'retry' }))).status, 403)
  assert.equal((await request(`/api/admin/photo-transfers/${task.id}/retry`, 1, post({ reason: 'retry cleanup' }))).status, 200)
  assert.equal(await transfers.processOwnershipTransfer(task.id), true)
  assert.equal(transfers.transferDto(task.id).state, 'completed'); assert.equal(row(t.photos, t.photos.id, p.id).transferState, 'idle')
  await assert.rejects(stat(path.join(rt.scratch, 'storage', p.key)), { code: 'ENOENT' })
  assert.equal(row(t.photoFiles, t.photoFiles.id, p.assetId).storageKey, 'photos/bravo/照片/keep.jpg')
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).usedBytes, 0)
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 3).usedBytes, bytes.length)
})

test('shared recipients remain read-only through metadata, ACL and lifecycle services', async () => {
  const p = await photo({ ownerId: 2, visibility: 'shared' }); rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 3, grantedBy: 2 }).run()
  assert.equal((await request(`/api/assets/${p.assetId}`, 3)).status, 200)
  for (const mutate of [() => management.editPhotoMetadata(actor(3), p.id, { expectedVersion: 1, title: 'unauthorized' }), () => management.changePhotoVisibility(actor(3), p.id, { expectedAclVersion: 1, visibility: 'public', recipientIds: [] }), () => management.photoLifecycle(actor(3), p.id, 'trash')]) assert.throws(mutate, e => e.statusCode === 404)
  assert.equal(row(t.photos, t.photos.id, p.id).title, p.title)
})

test('ordinary recipient searches require a prefix and never expose a directory or email addresses', async () => {
  assert.deepEqual(await json('/api/me/recipients', 2), [])
  assert.deepEqual(await json('/api/me/recipients?q=br&ids=3,4', 2), [])
  const matches = await json('/api/me/recipients?q=bra', 2)
  assert.equal(matches.length, 1); assert.equal(matches[0].id, 3); assert.equal('email' in matches[0], false)
  const p = await photo({ ownerId: 2, visibility: 'shared' }); rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 3, grantedBy: 2 }).run()
  assert.deepEqual((await json('/api/me/recipients?ids=3,4', 2)).map(row => row.id), [3])
  assert.equal((await json('/api/me/recipients', 1)).length > 0, true)
})

test('storage reconciliation derives originals and pending reservations, audits repairs, and checks versions', async () => {
  await photo({ ownerId: 2 })
  const session = await uploads.initializeUpload(actor(2), uploads.uploadInputSchema.parse({ idempotencyKey: id(), parts: [{ role: 'original', relativePath: 'pending.jpg', size: bytes.length }] }))
  rt.db.update(t.userStorageUsage).set({ usedBytes: bytes.length + 10, reservedBytes: 0 }).where(eq(t.userStorageUsage.userId, 2)).run()
  const detail = await json('/api/admin/users/2', 1)
  assert.equal(detail.storageCheck.consistent, false); assert.deepEqual(detail.storageCheck.computed, { usedBytes: bytes.length, reservedBytes: bytes.length })
  assert.equal((await request('/api/admin/users/2/reconcile-storage', 2, post({ expectedVersion: 1, reason: 'repair' }))).status, 403)
  const repaired = await json('/api/admin/users/2/reconcile-storage', 1, post({ expectedVersion: 1, reason: 'repair accounting' }))
  assert.equal(repaired.consistent, true)
  assert.equal((await request('/api/admin/users/2/reconcile-storage', 1, post({ expectedVersion: 1, reason: 'stale' }))).status, 409)
  assert.equal(rt.db.select().from(t.auditLogs).all().filter(item => item.action === 'user.storage-reconcile').length, 1)
  const { cancelUpload } = await import('../server/services/uploads/cleanup.ts'); await cancelUpload(session.id, actor(2))
  assert.equal((await json('/api/admin/users/2', 1)).storageCheck.consistent, true)
})

test('storage capacity failure rejects a transfer before reserving quota or freezing the source', async () => {
  const p = await photo({ ownerId: 2 })
  const { FixedStore } = await import('../server/services/media-files/store.ts'), original = FixedStore.prototype.assertCapacity
  FixedStore.prototype.assertCapacity = async function() { throw createError({ statusCode: 507, message: 'test disk full' }) }
  try { await assert.rejects(transfers.startOwnershipTransfer(actor(1), p.id, { toUserId: 3, expectedAclVersion: 1, idempotencyKey: id(), reason: 'capacity' }), e => e.statusCode === 507) }
  finally { FixedStore.prototype.assertCapacity = original }
  assert.equal(row(t.photos, t.photos.id, p.id).transferState, 'idle'); assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 3).reservedBytes, 0)
  assert.equal(rt.db.select().from(t.photoOwnershipTransfers).all().length, 0)
})

test('photo filters, uploader summaries, user statistics and audit filters keep their scope', async () => {
  const p = await photo({ ownerId: 2, visibility: 'shared', uploadedBy: 1 }), q = await photo({ ownerId: 2, processingStatus: 'failed' })
  await photo({ ownerId: 3, visibility: 'public' }); rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 3, grantedBy: 2 }).run()
  const result = await json('/api/admin/photos?ownerId=2&visibility=shared&uploadedBy=1&moderationStatus=visible', 1)
  assert.deepEqual(result.items.map(item => item.id), [p.id]); assert.equal(result.items[0].shareCount, 1); assert.equal(result.items[0].uploader.username, 'administrator')
  assert.deepEqual((await json('/api/me/photos?state=failed', 2)).items.map(item => item.id), [q.id])
  const detail = await json('/api/admin/users/2', 1); assert.equal(detail.stats.total, 2); assert.equal(detail.stats.shared, 1); assert.equal(detail.stats.failed, 1)
  management.editPhotoMetadata(actor(2), p.id, { expectedVersion: 1, title: 'changed' })
  const logs = await json(`/api/admin/audit-logs?ownerId=2&targetType=photo&targetId=${p.id}&action=photo.metadata`, 1)
  assert.equal(logs.items.length, 1); assert.equal(logs.items[0].targetId, p.id)
})

test('batch lifecycle changes are atomic, versioned, idempotent and reject foreign photos', async () => {
  const p = await photo({ ownerId: 2 }), q = await photo({ ownerId: 3 })
  const input = { operationId: id(), action: 'trash', items: [{ id: p.id, expectedVersion: 1 }, { id: q.id, expectedVersion: 1 }] }
  assert.equal((await request('/api/me/photos/lifecycle-batch', 2, post(input))).status, 404); assert.equal(row(t.photos, t.photos.id, p.id).deletedAt, null)
  const owned = { ...input, operationId: id(), items: [input.items[0]] }
  await json('/api/me/photos/lifecycle-batch', 2, post(owned)); await json('/api/me/photos/lifecycle-batch', 2, post(owned))
  assert.equal(row(t.photos, t.photos.id, p.id).metadataVersion, 2)
  assert.equal((await request('/api/me/photos/lifecycle-batch', 2, post({ ...owned, operationId: id(), action: 'restore' }))).status, 409)
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).usedBytes, bytes.length)
})

test('upload restoration lists only the current actor and destination, without internal locators', async () => {
  const session = await uploads.initializeUpload(actor(2), uploads.uploadInputSchema.parse({ idempotencyKey: id(), parts: [{ role: 'original', relativePath: 'original.jpg', size: bytes.length }] }))
  const own = await json('/api/uploads/sessions', 2)
  assert.equal(own.items[0].id, session.id); assert.equal(own.items[0].parts[0].filename, 'original.jpg')
  assert.equal(JSON.stringify(own).includes('storageKey'), false); assert.equal(JSON.stringify(own).includes('data/.uploads'), false)
  assert.equal((await json('/api/uploads/sessions?ownerUserId=2', 3)).items.length, 0)
  assert.equal((await request(`/api/uploads/sessions/${session.id}`, 3)).status, 404)
  assert.equal((await request(`/api/uploads/sessions/${session.id}`, 1)).status, 200)
})

test('manual album removal and cover changes reject stale versions and record audit', async () => {
  const c = album(), p = await photo(), outside = await photo(); link(c.id, p.id)
  const update = data => request(`/api/albums/${c.id}`, 1, { ...post(data), method: 'PUT' })
  const version = row(t.collections, t.collections.id, c.id).aclVersion
  assert.equal((await update({ coverPhotoId: outside.id, expectedAclVersion: version, reason: 'cover' })).status, 422)
  assert.equal((await update({ coverPhotoId: p.id, expectedAclVersion: version, reason: 'cover' })).status, 200)
  assert.equal((await update({ coverPhotoId: '', expectedAclVersion: version, reason: 'stale' })).status, 409)
  const del = data => request(`/api/albums/${c.id}`, 1, { ...post(data), method: 'DELETE' })
  assert.equal((await del({ expectedAclVersion: version, reason: 'stale delete' })).status, 409)
  assert.equal((await del({ expectedAclVersion: row(t.collections, t.collections.id, c.id).aclVersion, reason: 'delete album' })).status, 200)
  assert.equal(row(t.collections, t.collections.id, c.id), undefined)
  assert.equal(!!row(t.photos, t.photos.id, p.id), true)
  assert.equal(rt.db.select().from(t.auditLogs).all().filter(a => a.action === 'collection.delete').length, 1)
})

test('account purge waits for original removal and debits quota once across concurrent workers', async () => {
  const p = await photo({ ownerId: 2 }), task = deletion.startUserDeletion(actor(1), 2, { expectedVersion: 1, mode: 'purge', idempotencyKey: id(), reason: 'purge account' })
  assert.equal(await deletion.processUserDeletion(2), false); assert.equal(row(t.users, t.users.id, 2).status, 'deleting')
  const { purgeRegisteredPhoto } = await import('../server/services/photo-management/purge.ts')
  await Promise.all([purgeRegisteredPhoto(p.id), purgeRegisteredPhoto(p.id)])
  assert.equal(row(t.userStorageUsage, t.userStorageUsage.userId, 2).usedBytes, 0)
  assert.equal(await deletion.processUserDeletion(2), true); assert.equal(deletion.deletionDto(task.id).state, 'completed')
  await assert.rejects(stat(path.join(rt.scratch, 'storage', p.key)), { code: 'ENOENT' })
})

test('account transfer moves its photos before tombstoning the former owner', async () => {
  const p = await photo({ ownerId: 2 }), task = deletion.startUserDeletion(actor(1), 2, { expectedVersion: 1, mode: 'transfer', targetUserId: 3, idempotencyKey: id(), reason: 'transfer account' })
  assert.equal(await deletion.processUserDeletion(2), false)
  const transfer = row(t.photoOwnershipTransfers, t.photoOwnershipTransfers.photoIdSnapshot, p.id)
  assert.equal(await transfers.processOwnershipTransfer(transfer.id), true)
  assert.equal(await deletion.processUserDeletion(2), true); assert.equal(deletion.deletionDto(task.id).state, 'completed')
  assert.equal(row(t.photos, t.photos.id, p.id).ownerId, 3); assert.equal(row(t.photos, t.photos.id, p.id).visibility, 'private')
})

test('deletion cleans uncommitted site uploads even though their reserved quota is zero', async () => {
  rt.db.update(t.users).set({ role: 'admin' }).where(eq(t.users.id, 4)).run()
  const session = await uploads.initializeUpload(actor(1), uploads.uploadInputSchema.parse({ idempotencyKey: id(), parts: [{ role: 'original', relativePath: 'site-original.jpg', size: bytes.length }] }), null)
  const part = row(t.uploadParts, t.uploadParts.sessionId, session.id)
  assert.equal((await request(part ? session.parts[0].url : '', 1, { method: 'PUT', body: bytes })).status, 200)
  assert.equal(row(t.uploadSessions, t.uploadSessions.id, session.id).reservedBytes, 0)
  deletion.startUserDeletion(actor(4), 1, { expectedVersion: 1, mode: 'purge', idempotencyKey: id(), reason: 'delete site uploader' })
  assert.equal(await deletion.processUserDeletion(1), false)
  assert.equal(!!row(t.uploadSessions, t.uploadSessions.id, session.id).stagingCleanedAt, true)
  assert.equal(await deletion.processUserDeletion(1), true)
})

test('private personal people never restrict explicitly shared photos or reveal names to recipients', async () => {
  const p = await photo({ ownerId: 2, visibility: 'shared' }), c = album('person', { ownershipType: 'user', ownerId: 2, visibility: 'admin' }), manual = album()
  rt.db.insert(t.people).values({ id: 'private-person', name: 'owner-only-name', collectionId: c.id, ownershipType: 'user', ownerId: 2 }).run(); face(p.id, 'private-person'); link(manual.id, p.id)
  rt.db.insert(t.photoShares).values({ photoId: p.id, recipientUserId: 3, grantedBy: 2 }).run()
  const detail = await json(`/api/albums/${manual.id}`, 3)
  assert.equal(detail.photos.some(photo => photo.id === p.id), true)
  const response = await json(`/api/photos/${p.id}/faces`, 3)
  assert.equal(response.faces[0].personId, null); assert.equal(response.faces[0].personName, null); assert.equal(response.faces[0].thumbnailUrl, null)
  assert.equal((await request('/api/people/private-person', 3)).status, 404)
})

test('gallery, map, manual covers and public DTOs share the photo permission boundary', async () => {
  const hidden = await photo({ ownerId: 2 }), visible = await photo({ ownerId: 2, visibility: 'public' }), c = album('manual', { coverPhotoId: hidden.id })
  link(c.id, hidden.id); link(c.id, visible.id)
  for (const userId of [null, 1, 3]) {
    const gallery = await json('/api/photos?gallery=1', userId), guestGallery = await json('/api/photos/visible', userId), map = await json('/api/map/photos', userId)
    assert.equal(gallery.some(p => p.id === hidden.id), false); assert.equal(JSON.stringify(map).includes(hidden.id), false)
    assert.equal(gallery.some(p => p.id === visible.id), true); assert.equal(JSON.stringify(map).includes(visible.id), true)
    assert.equal(guestGallery.some(p => p.id === hidden.id), false); assert.equal(guestGallery.some(p => p.id === visible.id), true)
    const detail = await json(`/api/albums/${c.id}`, userId)
    assert.equal(detail.photos.some(p => p.id === hidden.id), false); assert.notEqual(detail.coverPhotoId, hidden.id)
    assert.equal(JSON.stringify(detail).includes('photos/alice/'), false)
  }
})

test('anonymous homepage gallery returns registered image, video and Live Photo URLs', async () => {
  const image = await photo({ ownerId: 2, visibility: 'public', isLivePhoto: 1, dateTaken: '2026-10-31T12:00:00Z' })
  const video = await photo({ ownerId: 3, visibility: 'public', type: 'video', dateTaken: '2026-10-30T12:00:00Z' }, 'clip.mov')
  const urls = { downloadUrl: `/api/assets/${image.assetId}` }
  const expectedBytes = new Map([[urls.downloadUrl, bytes], [`/api/assets/${video.assetId}`, bytes]])
  for (const [role, field] of [['preview', 'originalUrl'], ['thumbnail', 'thumbnailUrl'], ['live_video', 'livePhotoVideoUrl']]) {
    const fileId = id(), key = `derived/${fileId}`, content = Buffer.concat([bytes, Buffer.from(role)])
    await rt.write(`storage/${key}`, content)
    rt.db.insert(t.photoFiles).values({ id: fileId, photoId: image.id, role, locatorType: 'provider', storageProviderId: 1, storageKey: key, byteSize: content.length, mimeType: role === 'live_video' ? 'video/quicktime' : 'image/jpeg' }).run()
    urls[field] = `/api/assets/${fileId}`
    expectedBytes.set(urls[field], content)
  }

  const gallery = await json('/api/photos/visible')
  assert.deepEqual(gallery, await json('/api/photos?gallery=1'))
  assert.deepEqual(gallery.map(p => p.id), [image.id, video.id])
  for (const [field, url] of Object.entries(urls)) assert.equal(gallery[0][field], url, field)
  assert.equal(gallery[1].originalUrl, `/api/assets/${video.assetId}`)
  assert.equal(gallery[1].livePhotoVideoUrl, null)
  for (const field of ['storageKey', 'libraryPath', 'ownerId', 'originalFilename']) assert.equal(field in gallery[0], false, field)
  for (const [url, expected] of expectedBytes) {
    assert.match(url, /^\/api\/assets\/[a-f0-9]{32}$/)
    const response = await request(url)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
  }
  const secondPage = await json('/api/photos/visible?limit=1&offset=1')
  assert.equal(secondPage.length, 1); assert.equal(secondPage[0].originalUrl, `/api/assets/${video.assetId}`)
})

test('public settings exclude secret values regardless of their public flag', async () => {
  rt.db.insert(t.settings).values([
    { namespace: 'app', key: 'title', type: 'string', value: 'Gallery', isPublic: true },
    { namespace: 'system', key: 'auth.github.clientSecret', type: 'string', value: 'must-not-leak', isPublic: true, isSecret: true },
    { namespace: 'system', key: 'futureSecret', type: 'string', value: 'must-not-leak-either', isPublic: true, isSecret: true },
    { namespace: 'system', key: 'firstLaunch', type: 'boolean', value: 'false', isPublic: false },
  ]).run()
  const response = await json('/api/system/settings/all')
  assert.equal(response.data.app.title, 'Gallery'); assert.equal(response.data.system.firstLaunch, false)
  assert.equal(JSON.stringify(response).includes('must-not-leak'), false)
})

test('OAuth never creates unknown users; known admin needs one-time TOTP before a session', async () => {
  for (const [key, value] of [['auth.github.enabled', true], ['auth.github.clientId', 'fixture-client'], ['auth.github.clientSecret', 'fixture-secret']]) rt.state.settings.set(`system:${key}`, value)
  rt.state.oauthIdentity = { email: 'unknown@test.invalid' }
  assert.equal((await request('/api/auth/github', null, { redirect: 'manual' })).status, 403)
  assert.equal(rt.db.select().from(t.users).all().length, 4)
  const secret = 'JBSWY3DPEHPK3PXP'
  rt.db.update(t.users).set({ totpEnabled: true, totpSecret: secret }).where(eq(t.users.id, 1)).run()
  rt.state.oauthIdentity = { email: 'administrator@test.invalid' }
  const first = await request('/api/auth/github', null, { redirect: 'manual' })
  assert.equal(first.status, 302); assert.equal(first.headers.get('location'), '/login?step=verify')
  const challenge = first.headers.getSetCookie().find(v => v.startsWith(totpConstants.CHALLENGE_COOKIE + '='))?.split(';')[0]
  assert.ok(challenge); assert.equal(first.headers.getSetCookie().some(v => /^test_session=1(?:;|$)/.test(v)), false)
  const csrf = first.headers.get('x-csrf-token')
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const hash = createHmac('sha1', base32Decode(secret)).update(message).digest(), offset = hash[19] & 15
  const code = String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0')
  const verify = () => request('/api/login/2fa', null, { ...post({ code }), cookie: challenge, headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf } })
  assert.equal((await verify()).status, 201); assert.equal((await verify()).status, 401)
})
