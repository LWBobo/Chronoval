import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createServer } from 'node:http'
import path from 'node:path'
import { createSecurityRuntime } from './test-utils/security-runtime.mjs'
import * as tables from '../server/database/schema.ts'
import {
  photoAssetUrl,
  parsePhotoAssetId,
  withPhotoAssetUrls,
} from '../server/utils/asset-reference.ts'
import { resolveApiAccess } from '../server/utils/access-policy.ts'

let runtime
let upstream
let upstreamOrigin
let responseHook
const received = []
const bytes = Buffer.from('same-original-asset-bytes-0123456789')
const request = (url, options = {}) => fetch(runtime.origin + url, options)

async function photo(id, extra = {}) {
  const rel = `clips/${id}.MOV`
  await runtime.write(`library/${rel}`, bytes)
  const row = {
    id,
    source: 'library',
    type: 'video',
    libraryId: 1,
    libraryMount: 'scan_1',
    libraryPath: rel,
    storageKey: `scan_1/${rel}`,
    originalUrl: `/library/scan_1/${encodeURIComponent(rel).replace(/%2F/g, '/')}`,
    ...extra,
  }
  runtime.db.insert(tables.photos).values(row).run()
  return row
}

before(async () => {
  runtime = await createSecurityRuntime()
  await runtime.mount('/api/assets/:assetId', 'server/api/assets/[assetId].ts')
  await runtime.mount(
    '/api/assets/:assetId',
    'server/api/assets/[assetId].ts',
    'head',
  )
  const plugin = (await import('../server/plugins/photo-asset-urls.ts')).default
  plugin({
    hooks: {
      hook(name, callback) {
        assert.equal(name, 'beforeResponse')
        responseHook = callback
      },
    },
  })
  const gallery = (await import('../server/api/photos/index.get.ts')).default
  runtime.router.get(
    '/api/photos',
    globalThis.eventHandler(async (event) => {
      const response = { body: await gallery(event) }
      responseHook(event, response)
      return response.body
    }),
  )
  runtime.router.get(
    '/api/system/settings/all',
    globalThis.eventHandler((event) => {
      const response = {
        body: { id: 'config', type: 'video', originalUrl: '/config.MOV' },
      }
      responseHook(event, response)
      return response.body
    }),
  )
  upstream = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers, method: req.method })
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('ETag', '"asset-test"')
    if (req.headers['if-none-match'] === '"asset-test"') {
      res.statusCode = 304
      return res.end()
    }
    if (req.headers.range === 'bytes=2-6') {
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes 2-6/${bytes.length}`)
      res.setHeader('Content-Length', 5)
      return res.end(bytes.subarray(2, 7))
    }
    if (req.headers.range === 'bytes=9999-') {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${bytes.length}`)
      return res.end()
    }
    res.setHeader('Content-Length', bytes.length)
    res.end(bytes)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`
})
after(async () => {
  if (upstream)
    await new Promise((resolve) => {
      upstream.close(resolve)
      upstream.closeAllConnections()
    })
  if (runtime) await runtime.close()
})
beforeEach(() => {
  for (const table of [
    'collectionPhotos',
    'accessGrants',
    'collections',
    'photos',
    'libraries',
    'users',
  ])
    runtime.db.delete(tables[table]).run()
  received.length = 0
  runtime.state.scanAuth.clear()
  runtime.state.scanVisibility.clear()
  const rootPath = path.join(runtime.scratch, 'library')
  const lib = {
    id: 1,
    name: 'assets',
    rootPath,
    enabled: true,
    displayMode: 'both',
  }
  runtime.db.insert(tables.libraries).values(lib).run()
  runtime.state.libraries = [lib]
  runtime.state.mounts = [{ name: 'scan_1', root: rootPath }]
  runtime.db
    .insert(tables.users)
    .values({
      id: 1,
      username: 'admin',
      email: 'admin@example.test',
      role: 'admin',
      isAdmin: 1,
      createdAt: new Date(),
      password: 'test',
    })
    .run()
})

test('asset URLs are stable, contain only hex identifiers, and have no filename or query', () => {
  for (const id of ['lib_video_123', 'IMG_0001.MOV', '旅行 %20/video.mp4']) {
    for (const kind of ['original', 'live']) {
      const url = photoAssetUrl(id, kind)
      assert.match(url, /^\/api\/assets\/[a-f0-9]+$/)
      assert(!/video|\.mp4|\.mov|\?/i.test(url))
      assert.equal(photoAssetUrl(id, kind), url)
      assert.deepEqual(parsePhotoAssetId(url.split('/').pop()), {
        photoId: id,
        kind,
      })
    }
    assert.notEqual(photoAssetUrl(id, 'original'), photoAssetUrl(id, 'live'))
  }
  for (const bad of [
    '',
    'abc',
    '2aa',
    '0ff',
    '0610',
    '0' + '61'.repeat(1025),
  ]) {
    assert.equal(parsePhotoAssetId(bad), null, bad.slice(0, 20))
  }
})

test('only playback URLs change in nested responses, without mutating rows or image URLs', () => {
  const still = { id: 'still', type: 'image', originalUrl: '/photo.jpg' }
  const clip = {
    id: 'clip',
    type: 'video',
    originalUrl: '/clip.MOV',
    thumbnailUrl: '/thumb.jpg',
  }
  const live = {
    id: 'live',
    isLivePhoto: true,
    originalUrl: '/still.jpg',
    livePhotoVideoUrl: '/side.MOV',
  }
  const body = { photos: [still, clip], children: [{ photos: [live] }] }
  const rewritten = withPhotoAssetUrls(body)
  assert.equal(rewritten.photos[0], still)
  assert.equal(
    rewritten.photos[1].originalUrl,
    photoAssetUrl('clip', 'original'),
  )
  assert.equal(rewritten.photos[1].thumbnailUrl, '/thumb.jpg')
  assert.equal(rewritten.children[0].photos[0].originalUrl, '/still.jpg')
  assert.equal(
    rewritten.children[0].photos[0].livePhotoVideoUrl,
    photoAssetUrl('live', 'live'),
  )
  assert.equal(clip.originalUrl, '/clip.MOV')
  assert.equal(live.livePhotoVideoUrl, '/side.MOV')
  assert.equal(withPhotoAssetUrls(rewritten), rewritten)
  assert.equal(withPhotoAssetUrls(bytes), bytes)
})

test('read aliases are public at the API boundary while writes stay administrative', () => {
  const url = photoAssetUrl('clip', 'original')
  assert.equal(resolveApiAccess('GET', url), 'public')
  assert.equal(resolveApiAccess('HEAD', url), 'public')
  for (const method of ['POST', 'PUT', 'DELETE'])
    assert.equal(resolveApiAccess(method, url), 'admin')
})

test('gallery automatically returns asset URLs and unrelated API responses are unchanged', async () => {
  const row = await photo('gallery')
  const gallery = await request('/api/photos?gallery=1')
  assert.equal(gallery.status, 200)
  const body = await gallery.json()
  assert.equal(body[0].originalUrl, photoAssetUrl(row.id, 'original'))
  assert.equal(
    runtime.db.select().from(tables.photos).get().originalUrl,
    row.originalUrl,
  )
  const other = await request('/api/system/settings/all')
  assert.equal((await other.json()).originalUrl, '/config.MOV')
})

test('library alias returns original bytes directly, including Range, HEAD and conditional requests', async () => {
  const row = await photo('original')
  const url = photoAssetUrl(row.id, 'original')
  const response = await request(url)
  assert.equal(response.status, 200)
  assert.equal(response.redirected, false)
  assert.equal(response.headers.get('location'), null)
  assert.equal(response.headers.get('content-type'), 'video/quicktime')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  const range = await request(url, { headers: { Range: 'bytes=2-6' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), `bytes 2-6/${bytes.length}`)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 7))
  const head = await request(url, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), bytes.length)
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const cached = await request(url, {
    headers: { 'If-None-Match': response.headers.get('etag') },
  })
  assert.equal(cached.status, 304)
})

test('local storage and sidecar aliases preserve content and resource selection', async () => {
  await runtime.write('storage/photos/side.MOV', bytes)
  await runtime.write('storage/photos/main.mp4', bytes)
  const main = await photo('stored', {
    source: 'upload',
    libraryMount: null,
    libraryPath: null,
    libraryId: null,
    storageKey: 'photos/main.mp4',
    originalUrl: '/storage/photos/main.mp4',
  })
  const live = await photo('sidecar', {
    type: 'image',
    isLivePhoto: 1,
    livePhotoVideoKey: 'photos/side.MOV',
    livePhotoVideoUrl: '/storage/photos/side.MOV',
  })
  for (const [row, kind] of [
    [main, 'original'],
    [live, 'live'],
  ]) {
    const response = await request(photoAssetUrl(row.id, kind))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  assert.equal((await request(photoAssetUrl(live.id, 'original'))).status, 404)
})

test('embedded aliases return only the embedded clip and retain relative byte ranges', async () => {
  const prefix = Buffer.from('original-photo-prefix')
  await runtime.write('library/embedded.jpg', Buffer.concat([prefix, bytes]))
  const row = await photo('embedded', {
    type: 'image',
    libraryPath: 'embedded.jpg',
    originalUrl: '/library/scan_1/embedded.jpg',
    isLivePhoto: 1,
    livePhotoVideoKey: `embedded:${prefix.length}`,
    livePhotoVideoUrl: '/api/photos/embedded/motion-video',
  })
  const url = photoAssetUrl(row.id, 'live')
  const response = await request(url)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  const head = await request(url, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), bytes.length)
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const suffix = await request(url, { headers: { Range: 'bytes=-4' } })
  assert.equal(suffix.status, 206)
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-4))
  const invalid = await request(url, { headers: { Range: 'bytes=9999-' } })
  assert.equal(invalid.status, 416)
})

test('external storage is streamed through the alias without leaking cookies or redirecting clients', async () => {
  const row = await photo('external', {
    source: 'upload',
    originalUrl: upstreamOrigin + '/private/video.mp4?key=stored',
  })
  const url = photoAssetUrl(row.id, 'original')
  const response = await request(url, {
    headers: { Cookie: 'unrelated=secret' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.redirected, false)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal(received[0].url, '/private/video.mp4?key=stored')
  assert.equal(received[0].headers.cookie, undefined)
  const range = await request(url, { headers: { Range: 'bytes=2-6' } })
  assert.equal(range.status, 206)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 7))
  const cached = await request(url, {
    headers: { 'If-None-Match': '"asset-test"' },
  })
  assert.equal(cached.status, 304)
  const head = await request(url, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), bytes.length)
  const invalid = await request(url, { headers: { Range: 'bytes=9999-' } })
  assert.equal(invalid.status, 416)
})

test('aliases cannot bypass album visibility or password checks', async () => {
  const row = await photo('restricted')
  runtime.db
    .insert(tables.collections)
    .values({
      id: 20,
      kind: 'manual',
      title: 'restricted',
      uid: 'restricted',
      passwordHash: 'locked',
    })
    .run()
  runtime.db
    .insert(tables.accessGrants)
    .values({ collectionId: 20, audience: 'admin' })
    .run()
  runtime.db
    .insert(tables.collectionPhotos)
    .values({ collectionId: 20, photoId: row.id })
    .run()
  const url = photoAssetUrl(row.id, 'original')
  assert.equal((await request(url)).status, 404)
  const admin = await request(url, { headers: { Cookie: 'test_session=1' } })
  assert.equal(admin.status, 200)
  await admin.arrayBuffer()
  runtime.db.update(tables.accessGrants).set({ audience: 'public' }).run()
  assert.equal((await request(url)).status, 404)
})

test('missing, malformed, deleted and wrong-kind resources cannot be read', async () => {
  assert.equal((await request('/api/assets/0ff')).status, 404)
  assert.equal((await request(photoAssetUrl('absent', 'original'))).status, 404)
  const row = await photo('deleted', { deletedAt: new Date() })
  assert.equal((await request(photoAssetUrl(row.id, 'original'))).status, 404)
  const plain = await photo('plain')
  assert.equal((await request(photoAssetUrl(plain.id, 'live'))).status, 404)
})
