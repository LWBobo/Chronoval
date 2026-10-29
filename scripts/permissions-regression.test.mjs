import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createHmac } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { createSecurityRuntime } from './test-utils/security-runtime.mjs'
import * as tables from '../server/database/schema.ts'

let runtime
let sessionAuth
let originalCwd
let jpeg
const userCookie = (id) => (id ? `test_session=${id}` : '')
const fetchAs = (url, id = null, options = {}) =>
  fetch(runtime.origin + url, {
    ...options,
    headers: {
      ...options.headers,
      Cookie: [userCookie(id), options.cookie].filter(Boolean).join('; '),
    },
  })
const jsonAs = async (...args) => {
  const response = await fetchAs(...args)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
function folder(
  id,
  relPath,
  visibility = 'public',
  passwordHash = null,
  extra = {},
) {
  runtime.db
    .insert(tables.collections)
    .values({
      id,
      kind: 'folder',
      libraryId: 1,
      relPath,
      passwordHash,
      ...extra,
    })
    .run()
  runtime.db
    .insert(tables.accessGrants)
    .values({ collectionId: id, audience: visibility })
    .run()
  runtime.state.scanVisibility.set(`1:${relPath}`, visibility)
  runtime.state.scanAuth.set(`1:${relPath}`, {
    passwordHash,
    exemptMode: null,
    exemptUsers: [],
  })
}
function manual(id, visibility = 'public', passwordHash = null) {
  runtime.db
    .insert(tables.collections)
    .values({
      id,
      kind: 'manual',
      title: `album-${id}`,
      uid: `album-uid-${id}`,
      passwordHash,
    })
    .run()
  runtime.db
    .insert(tables.accessGrants)
    .values({ collectionId: id, audience: visibility })
    .run()
}
async function photo(id, relPath = `${id}.jpg`, extra = {}) {
  const url = `/library/scan_1/${encodeURIComponent(relPath).replace(/%2F/g, '/')}`
  await runtime.write(`library/${relPath}`, jpeg)
  await runtime.write(`storage/thumbnails/${id}.jpg`, jpeg)
  const row = {
    id,
    title: id,
    source: 'library',
    type: 'image',
    libraryId: 1,
    libraryMount: 'scan_1',
    libraryPath: relPath,
    storageKey: `scan_1/${relPath}`,
    originalUrl: url,
    thumbnailUrl: `/storage/thumbnails/${id}.jpg`,
    thumbnailKey: `thumbnails/${id}.jpg`,
    dateTaken: '2026-10-01T12:00:00Z',
    latitude: 30,
    longitude: 120,
    ...extra,
  }
  runtime.db.insert(tables.photos).values(row).run()
  return row
}
const scanCookie = (relPath, hash) => {
  const scope = sessionAuth.scanAlbumCookieName(1, relPath)
  return `${scope}=${encodeURIComponent(`1:${sessionAuth.scanAlbumToken(scope, hash)}`)}`
}
const manualCookie = (id, hash) =>
  `album_${id}=${encodeURIComponent(`${id}:${globalThis.__manualToken(id, hash)}`)}`

before(async () => {
  runtime = await createSecurityRuntime()
  originalCwd = process.cwd()
  process.chdir(runtime.scratch)
  sessionAuth = await import('../server/utils/scanAlbumAuth.ts')
  globalThis.__manualToken = (
    await import('../server/utils/manualAlbumAuth.ts')
  ).albumToken
  jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#2468ab' },
  })
    .jpeg()
    .toBuffer()
  const routes = [
    ['/library/**', 'server/routes/library/[...path].ts'],
    ['/storage/**', 'server/routes/storage/[...path].ts'],
    ['/image/**', 'server/routes/image/[...key].get.ts'],
    ['/thumb/**', 'server/routes/thumb/[...thumbnailUrl].get.ts'],
    ['/api/photos', 'server/api/photos/index.get.ts'],
    ['/api/map/photos', 'server/api/map/photos.get.ts'],
    [
      '/api/map/photos/:photoId/thumbnail',
      'server/api/map/photos/[photoId]/thumbnail.get.ts',
    ],
    [
      '/api/photos/:photoId/livephoto',
      'server/api/photos/[photoId]/livephoto.get.ts',
    ],
    [
      '/api/photos/:photoId/motion-video',
      'server/api/photos/[photoId]/motion-video.get.ts',
    ],
    [
      '/api/faces/:faceId/thumbnail',
      'server/api/faces/[faceId]/thumbnail.get.ts',
    ],
    ['/api/people', 'server/api/people/index.get.ts'],
    ['/api/people/:id', 'server/api/people/[id].get.ts'],
    ['/api/albums', 'server/api/albums/index.get.ts'],
    ['/api/albums/:albumId', 'server/api/albums/[albumId]/index.get.ts'],
    ['/api/albums/scan/:libId', 'server/api/albums/scan/[libId].get.ts'],
    [
      '/api/albums/scan/:libId',
      'server/api/albums/scan/[libId].post.ts',
      'post',
    ],
    [
      '/api/people/photo-search',
      'server/api/people/photo-search.post.ts',
      'post',
    ],
    ['/api/music/:id/stream', 'server/api/music/[id]/stream.get.ts'],
    ['/api/system/settings/all', 'server/api/system/settings/all.get.ts'],
    ['/api/users', 'server/api/users/index.get.ts'],
    ['/api/profile', 'server/api/profile.get.ts'],
    ['/api/auth/github', 'server/api/auth/github.get.ts'],
    ['/api/login', 'server/api/login.post.ts', 'post'],
    ['/api/login/2fa', 'server/api/login/2fa.post.ts', 'post'],
  ]
  for (const [route, filename, method] of routes)
    await runtime.mount(route, filename, method)
  await runtime.mount(
    '/api/photos/:photoId/albums',
    'server/api/photos/[photoId]/albums.get.ts',
  )
  runtime.router.get(
    '/api/_auth/session',
    globalThis.eventHandler(async (event) => {
      const session = await globalThis.getUserSession(event)
      for (const hook of runtime.state.sessionFetchHooks)
        await hook(session, event)
      return session
    }),
  )
  runtime.router.delete(
    '/api/_auth/session',
    globalThis.eventHandler(async (event) => {
      await globalThis.clearUserSession(event)
      return { loggedOut: true }
    }),
  )
})
after(async () => {
  if (originalCwd) process.chdir(originalCwd)
  if (runtime) await runtime.close()
})
beforeEach(() => {
  for (const name of [
    'accessGrants',
    'assetFaces',
    'people',
    'collectionPhotos',
    'collections',
    'photos',
    'libraries',
    'music',
    'users',
    'settings',
  ])
    runtime.db.delete(tables[name]).run()
  runtime.state.scanAuth.clear()
  runtime.state.scanVisibility.clear()
  runtime.state.scanRoots = []
  runtime.state.scanDetail = null
  runtime.state.loginAttempts = []
  runtime.state.settings.clear()
  runtime.state.settings.set('system:firstLaunch', false)
  const rootPath = path.join(runtime.scratch, 'library')
  const lib = {
    id: 1,
    name: 'test-library',
    rootPath,
    enabled: true,
    displayMode: 'both',
    urlKey: 'library-key',
  }
  runtime.db.insert(tables.libraries).values(lib).run()
  runtime.state.libraries = [lib]
  runtime.state.mounts = [{ name: 'scan_1', root: rootPath }]
  runtime.state.photoImage = jpeg
  for (const id of [1, 2, 3])
    runtime.db
      .insert(tables.users)
      .values({
        id,
        username: `user-${id}`,
        email: `user-${id}@example.test`,
        role: id === 1 ? 'admin' : 'user',
        isAdmin: id === 1 ? 1 : 0,
        createdAt: new Date(),
        password: 'test-password',
      })
      .run()
})

for (const relPath of [
  'ASCII/IMG_01.jpg',
  '北海/照片 01.jpg',
  '100%/literal%20name.jpg',
  'emoji/🌊+海边#.jpg',
  'folder/photo..jpg',
]) {
  test(`gallery-visible file can be opened through original, thumbnail and proxy: ${relPath}`, async () => {
    const row = await photo('visible', relPath)
    const gallery = await jsonAs('/api/photos?gallery=1')
    assert.deepEqual(
      gallery.map((item) => item.id),
      ['visible'],
    )
    for (const url of [
      row.originalUrl,
      row.thumbnailUrl,
      `/thumb/${encodeURIComponent(row.originalUrl)}`,
    ]) {
      const response = await fetchAs(url)
      assert.equal(
        response.status,
        200,
        `${url}: ${await response.clone().text()}`,
      )
      const image = await sharp(
        Buffer.from(await response.arrayBuffer()),
      ).metadata()
      assert.equal(image.width, 8)
      assert.equal(response.headers.get('cache-control'), 'private, no-cache')
    }
  })
}

for (const [viewer, rank] of [
  [null, 0],
  [2, 1],
  [1, 2],
]) {
  test(`gallery, map and direct media enforce public/login/admin consistently for viewer ${viewer ?? 'guest'}`, async () => {
    const levels = ['public', 'login', 'admin']
    const rows = []
    for (let level = 0; level < levels.length; level++) {
      folder(10 + level, levels[level], levels[level])
      rows.push(await photo(levels[level], `${levels[level]}/photo.jpg`))
    }
    const allowed = levels.slice(0, rank + 1)
    const gallery = await jsonAs('/api/photos?gallery=1', viewer)
    const map = await jsonAs('/api/map/photos', viewer)
    assert.deepEqual(gallery.map((row) => row.id).sort(), [...allowed].sort())
    assert.deepEqual(
      map.photos.map((row) => row.id).sort(),
      [...allowed].sort(),
    )
    for (let index = 0; index < rows.length; index++) {
      const expected = index <= rank ? 200 : 404
      for (const url of [
        rows[index].originalUrl,
        rows[index].thumbnailUrl,
        `/thumb/${encodeURIComponent(rows[index].originalUrl)}`,
        `/api/map/photos/${rows[index].id}/thumbnail`,
        `/api/photos/${rows[index].id}/livephoto`,
      ]) {
        const response = await fetchAs(url, viewer)
        assert.equal(response.status, expected, `${url} for ${viewer}`)
        await response.arrayBuffer()
      }
    }
  })
}

test('uploaded originals with encoded storage keys remain readable and permission protected', async () => {
  const key = 'photos/上传 照片%20.jpg'
  await runtime.write(`storage/${key}`, jpeg)
  runtime.db
    .insert(tables.photos)
    .values({
      id: 'upload',
      source: 'upload',
      storageKey: key,
      originalUrl: `/image/${encodeURIComponent(key)}`,
    })
    .run()
  const response = await fetchAs(`/image/${encodeURIComponent(key)}`)
  assert.equal(response.status, 200)
  assert.equal(
    (await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width,
    8,
  )
  manual(20, 'admin')
  runtime.db
    .insert(tables.collectionPhotos)
    .values({ collectionId: 20, photoId: 'upload' })
    .run()
  assert.equal((await fetchAs(`/image/${encodeURIComponent(key)}`)).status, 404)
})

test('valid password cookies never override login visibility and all album memberships are restrictive', async () => {
  const row = await photo('shared')
  manual(20)
  manual(21, 'login', 'password-hash')
  runtime.db
    .insert(tables.collectionPhotos)
    .values([
      { collectionId: 20, photoId: row.id },
      { collectionId: 21, photoId: row.id },
    ])
    .run()
  const cookie = manualCookie(21, 'password-hash')
  assert.equal((await fetchAs(row.originalUrl, null, { cookie })).status, 404)
  assert.equal((await fetchAs(row.originalUrl, 2, { cookie })).status, 200)
  assert.equal((await fetchAs(row.originalUrl, 3)).status, 404)
  const album = await jsonAs('/api/albums/album-uid-21', 2, { cookie })
  assert.deepEqual(
    album.photos.map((item) => item.id),
    [row.id],
  )
  assert.equal('passwordHash' in album, false)
  assert.equal('storageKey' in album.photos[0], false)
})

test('root unlock permits inheritance but cannot cross a child password boundary', async () => {
  folder(10, '', 'public', 'root-hash')
  folder(11, 'inherited')
  folder(12, 'private', 'public', 'child-hash')
  folder(13, 'private/deeper')
  const inherited = await photo('inherited', 'inherited/photo.jpg')
  const nested = await photo('nested', 'private/deeper/photo.jpg')
  const rootCookie = scanCookie('', 'root-hash')
  assert.equal(
    (await fetchAs(inherited.originalUrl, null, { cookie: rootCookie })).status,
    200,
  )
  assert.equal(
    (await fetchAs(nested.originalUrl, null, { cookie: rootCookie })).status,
    404,
  )
  assert.equal(
    (
      await fetchAs(nested.originalUrl, null, {
        cookie: scanCookie('private', 'child-hash'),
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await fetchAs(nested.originalUrl, null, {
        cookie: scanCookie('private/deeper', 'child-hash'),
      })
    ).status,
    200,
  )
})

test('Chinese sibling unlock scopes cannot collide or unlock each other', async () => {
  folder(10, '', 'public', 'root-hash')
  folder(11, '北海')
  folder(12, '上海')
  const north = await photo('north', '北海/photo.jpg')
  const south = await photo('south', '上海/photo.jpg')
  assert.notEqual(
    sessionAuth.scanAlbumCookieName(1, '北海'),
    sessionAuth.scanAlbumCookieName(1, '上海'),
  )
  const cookie = scanCookie('北海', 'root-hash')
  assert.equal((await fetchAs(north.originalUrl, null, { cookie })).status, 200)
  assert.equal((await fetchAs(south.originalUrl, null, { cookie })).status, 404)
})

test('changing an album password invalidates its existing unlock cookies', async () => {
  folder(10, '', 'public', 'old-hash')
  const row = await photo('changing')
  const cookie = scanCookie('', 'old-hash')
  assert.equal((await fetchAs(row.originalUrl, null, { cookie })).status, 200)
  runtime.db.update(tables.collections).set({ passwordHash: 'new-hash' }).run()
  assert.equal((await fetchAs(row.originalUrl, null, { cookie })).status, 404)
  assert.equal(
    (
      await fetchAs(row.originalUrl, null, {
        cookie: scanCookie('', 'new-hash'),
      })
    ).status,
    200,
  )
})

test('conditional requests recheck permission before returning 304', async () => {
  folder(10, 'changing')
  const row = await photo('changing', 'changing/photo.jpg')
  const response = await fetchAs(row.originalUrl)
  assert.equal(response.status, 200)
  const etag = response.headers.get('etag')
  assert(etag)
  await response.arrayBuffer()
  assert.equal(
    (
      await fetchAs(row.originalUrl, null, {
        headers: { 'If-None-Match': etag },
      })
    ).status,
    304,
  )
  runtime.db.update(tables.accessGrants).set({ audience: 'login' }).run()
  const revoked = await fetchAs(row.originalUrl, null, {
    headers: { 'If-None-Match': etag },
  })
  assert.equal(revoked.status, 404)
  assert.equal(revoked.headers.get('cache-control'), 'private, no-store')
})

test('disabled libraries and trashed photos disappear from guest lists and media', async () => {
  const row = await photo('disabled')
  runtime.db.update(tables.libraries).set({ enabled: false }).run()
  assert.deepEqual(await jsonAs('/api/photos?gallery=1'), [])
  assert.equal((await fetchAs(row.thumbnailUrl)).status, 404)
  runtime.db.update(tables.libraries).set({ enabled: true }).run()
  runtime.db.update(tables.photos).set({ deletedAt: new Date() }).run()
  assert.equal((await fetchAs(row.originalUrl)).status, 404)
  assert.deepEqual(await jsonAs('/api/photos?gallery=1'), [])
})

test('malformed paths and traversal are rejected without serving unrelated files', async () => {
  for (const url of [
    '/library/scan_1/%',
    '/storage/%',
    '/image/%',
    '/thumb/%',
  ]) {
    assert.equal((await fetchAs(url)).status, 400, url)
  }
  const response = await fetchAs('/library/scan_1/..%2Foutside.jpg')
  assert.equal(response.status, 400)
})

test('normal accounts can fetch their own sessions but stale admin claims do not grant access', async () => {
  const own = await jsonAs('/api/_auth/session', 2)
  assert.equal(own.user.id, 2)
  assert.equal(own.user.isAdmin, false)
  assert.equal((await fetchAs('/api/users', 2)).status, 403)
  assert.equal((await fetchAs('/api/users')).status, 401)
  assert.equal((await fetchAs('/api/users', 1)).status, 200)
  // The legacy flag cannot override the authoritative role.
  runtime.db
    .update(tables.users)
    .set({ role: 'user' })
    .where(globalThis.eq(tables.users.id, 1))
    .run()
  assert.equal((await fetchAs('/api/users', 1)).status, 403)
  assert.equal((await jsonAs('/api/_auth/session', 1)).user.isAdmin, false)
  const loggedOut = await fetchAs('/api/_auth/session', 2, { method: 'DELETE' })
  assert.equal(loggedOut.status, 200)
  assert.match(loggedOut.headers.get('set-cookie'), /test_session=/)
})

test('deleted accounts do not retain session access', async () => {
  runtime.db.delete(tables.users).where(globalThis.eq(tables.users.id, 2)).run()
  assert.equal((await fetchAs('/api/profile', 2)).status, 401)
  const session = await jsonAs('/api/_auth/session', 2)
  assert.equal(session.user, undefined)
})

test('public settings never return secret rows even if isPublic was enabled', async () => {
  runtime.db
    .insert(tables.settings)
    .values([
      {
        namespace: 'app',
        key: 'title',
        type: 'string',
        value: 'Gallery',
        isPublic: true,
      },
      {
        namespace: 'system',
        key: 'auth.github.clientSecret',
        type: 'string',
        value: 'must-not-leak',
        isPublic: true,
        isSecret: true,
      },
      {
        namespace: 'system',
        key: 'futureSecret',
        type: 'string',
        value: 'future-secret-must-not-leak',
        isPublic: true,
        isSecret: true,
      },
      {
        namespace: 'system',
        key: 'firstLaunch',
        type: 'boolean',
        value: 'false',
        isPublic: false,
      },
    ])
    .run()
  const response = await jsonAs('/api/system/settings/all')
  assert.equal(response.data.app.title, 'Gallery')
  assert.equal(response.data.system.firstLaunch, false)
  assert.equal(JSON.stringify(response).includes('must-not-leak'), false)
})

test('recursive scan nodes hide private descendants, protected covers and BGM', async () => {
  folder(10, '')
  folder(11, 'private', 'admin')
  folder(12, 'locked', 'public', 'locked-hash')
  const hidden = await photo('hidden-cover', 'private/photo.jpg')
  const locked = await photo('locked-cover', 'locked/photo.jpg')
  const visible = await photo('visible', 'visible.jpg')
  const node = (relPath, covers = []) => ({
    kind: 'scan',
    libId: 1,
    relPath,
    title: relPath || 'root',
    covers,
    coverPhotoId: covers[0]?.id,
    photoCount: 99,
    videoCount: 99,
    bgmMusicId: 123,
    passwordExemptUsers: ['private-email@example.test'],
  })
  runtime.state.scanRoots = [
    {
      ...node('', [hidden, visible]),
      children: [
        node('private', [hidden]),
        {
          ...node('locked', [locked]),
          children: [node('locked/deeper', [locked])],
        },
      ],
    },
  ]
  const albums = await jsonAs('/api/albums')
  const root = albums.find((album) => album.kind === 'scan')
  assert.equal(root.photoCount, 1)
  assert.deepEqual(
    root.covers.map((cover) => cover.id),
    ['visible'],
  )
  assert.deepEqual(
    root.children.map((child) => child.relPath),
    ['locked'],
  )
  assert.deepEqual(root.children[0].covers, [])
  assert.deepEqual(root.children[0].children, [])
  assert.equal(root.children[0].bgm, null)
  assert.equal(root.children[0].photoCount, 0)
  assert.equal(JSON.stringify(albums).includes('private-email'), false)
  assert.equal(JSON.stringify(albums).includes(hidden.originalUrl), false)
})

test('scan album details and media agree on inherited and overridden passwords', async () => {
  folder(10, '', 'public', 'root-hash')
  folder(11, 'child', 'public', 'child-hash')
  const row = await photo('child-photo', 'child/photo.jpg')
  runtime.state.scanDetail = {
    node: {
      kind: 'scan',
      libId: 1,
      relPath: 'child',
      title: 'child',
      covers: [row],
      coverPhotoId: row.id,
    },
    dirPhotos: [row],
    children: [],
  }
  const locked = await jsonAs('/api/albums/scan/1?path=child', null, {
    cookie: scanCookie('', 'root-hash'),
  })
  assert.equal(locked.authorized, false)
  assert.deepEqual(locked.dirPhotos, [])
  const unlocked = await jsonAs('/api/albums/scan/1?path=child', null, {
    cookie: scanCookie('child', 'child-hash'),
  })
  assert.equal(unlocked.authorized, true)
  assert.deepEqual(
    unlocked.dirPhotos.map((item) => item.id),
    [row.id],
  )
  assert.equal(
    (
      await fetchAs(unlocked.dirPhotos[0].originalUrl, null, {
        cookie: scanCookie('child', 'child-hash'),
      })
    ).status,
    200,
  )
})

test('BGM honors ancestor visibility and child password overrides', async () => {
  runtime.db
    .insert(tables.music)
    .values({
      id: 1,
      title: 'private-track',
      filename: 'audio.mp3',
      storageKey: 'music/track.mp3',
    })
    .run()
  await runtime.write('storage/music/track.mp3', Buffer.from('test-audio'))
  folder(10, '', 'public', 'root-hash')
  folder(11, 'child', 'public', 'child-hash', { bgmMusicId: 1 })
  assert.equal(
    (
      await fetchAs('/api/music/1/stream', null, {
        cookie: scanCookie('', 'root-hash'),
      })
    ).status,
    404,
  )
  assert.equal(
    (
      await fetchAs('/api/music/1/stream', null, {
        cookie: scanCookie('child', 'child-hash'),
      })
    ).status,
    200,
  )
  runtime.db
    .update(tables.accessGrants)
    .set({ audience: 'admin' })
    .where(globalThis.eq(tables.accessGrants.collectionId, 11))
    .run()
  assert.equal(
    (
      await fetchAs('/api/music/1/stream', null, {
        cookie: scanCookie('child', 'child-hash'),
      })
    ).status,
    404,
  )
})

test('OAuth users with 2FA receive only a pending challenge until TOTP succeeds', async () => {
  const secret = 'JBSWY3DPEHPK3PXP'
  runtime.db
    .update(tables.users)
    .set({ totpEnabled: true, totpSecret: secret })
    .where(globalThis.eq(tables.users.id, 1))
    .run()
  runtime.state.settings.set('system:auth.github.enabled', true)
  runtime.state.settings.set('system:auth.github.clientId', 'test-client-id')
  runtime.state.settings.set(
    'system:auth.github.clientSecret',
    'test-client-secret',
  )
  runtime.state.oauthIdentity = { email: 'user-1@example.test' }
  const response = await fetchAs('/api/auth/github', null, {
    redirect: 'manual',
  })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login?step=verify')
  const cookies = response.headers.getSetCookie()
  assert.equal(
    cookies.some((cookie) => /^test_session=1(?:;|$)/.test(cookie)),
    false,
  )
  const challenge = cookies
    .find((cookie) =>
      cookie.startsWith(globalThis.totpConstants.CHALLENGE_COOKIE + '='),
    )
    ?.split(';')[0]
  assert(challenge)
  assert.equal(
    (await fetchAs('/api/profile', null, { cookie: challenge })).status,
    401,
  )
  const wrong = await fetchAs('/api/login/2fa', null, {
    method: 'POST',
    cookie: challenge,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'invalid' }),
  })
  assert.equal(wrong.status, 401)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hash = createHmac('sha1', globalThis.base32Decode(secret))
    .update(message)
    .digest()
  const code = String(
    (hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0')
  const verify = () =>
    fetchAs('/api/login/2fa', null, {
      method: 'POST',
      cookie: challenge,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  const verified = await verify()
  assert.equal(verified.status, 201)
  assert(
    verified.headers
      .getSetCookie()
      .some((cookie) => /^test_session=1(?:;|$)/.test(cookie)),
  )
  assert.equal((await verify()).status, 401)
})

test('real scan metadata preserves Chinese, spaces and literal percent names through unlock and media', async () => {
  const { hashAlbumPassword } =
    await import('../server/utils/scanAlbumPassword.ts')
  for (const [index, relPath] of [
    '北海 旅行',
    '100%照片',
    'literal%20folder',
  ].entries()) {
    const hash = hashAlbumPassword('correct-password')
    folder(30 + index, relPath, 'public', hash)
    const row = await photo(`path-${index}`, `${relPath}/照片.jpg`)
    const endpoint = `/api/albums/scan/1?path=${encodeURIComponent(relPath)}`
    const locked = await jsonAs(endpoint)
    assert.equal(locked.passwordProtected, true)
    assert.equal(locked.authorized, false)
    assert.equal(locked.node.title, relPath)
    const unlock = await fetchAs(endpoint, null, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    assert.equal(unlock.status, 200, await unlock.clone().text())
    const cookie = unlock.headers
      .getSetCookie()
      .find((value) =>
        value.startsWith(sessionAuth.scanAlbumCookieName(1, relPath) + '='),
      )
      ?.split(';')[0]
    assert(cookie)
    const opened = await jsonAs(endpoint, null, { cookie })
    assert.equal(opened.authorized, true)
    assert.deepEqual(
      opened.dirPhotos.map((item) => item.id),
      [row.id],
    )
    assert.equal(
      (await fetchAs(opened.dirPhotos[0].originalUrl, null, { cookie })).status,
      200,
    )
  }
})

test('selected-user exemptions match page, gallery and media without granting other accounts', async () => {
  folder(10, '', 'login', 'root-hash')
  runtime.db
    .insert(tables.accessGrants)
    .values({ collectionId: 10, audience: 'user', userId: 2 })
    .run()
  const row = await photo('selected')
  assert.equal((await fetchAs(row.originalUrl, 2)).status, 200)
  assert.equal((await fetchAs(row.originalUrl, 3)).status, 404)
  assert.deepEqual(
    (await jsonAs('/api/photos?gallery=1', 2)).map((item) => item.id),
    [row.id],
  )
  assert.deepEqual(await jsonAs('/api/photos?gallery=1', 3), [])
  const page = await jsonAs('/api/albums/scan/1', 2)
  assert.equal(page.authorized, true)
  assert.deepEqual(
    page.dirPhotos.map((item) => item.id),
    [row.id],
  )
})

test('person restrictions apply to gallery, person pages, originals and face thumbnails', async () => {
  runtime.db
    .insert(tables.collections)
    .values({ id: 40, kind: 'person', title: 'private-person' })
    .run()
  runtime.db
    .insert(tables.accessGrants)
    .values({ collectionId: 40, audience: 'admin' })
    .run()
  runtime.db
    .insert(tables.people)
    .values({
      id: 'private-person',
      collectionId: 40,
      name: 'private-person',
      origin: 'manual',
    })
    .run()
  const row = await photo('person-photo')
  runtime.db
    .insert(tables.assetFaces)
    .values({
      id: 'face-1',
      personId: 'private-person',
      photoId: row.id,
      x1: 0.1,
      y1: 0.1,
      x2: 0.9,
      y2: 0.9,
      imageWidth: 8,
      imageHeight: 8,
      score: 1,
    })
    .run()
  for (const viewer of [null, 2]) {
    assert.deepEqual(await jsonAs('/api/photos?gallery=1', viewer), [])
    assert.equal((await fetchAs(row.originalUrl, viewer)).status, 404)
    assert.equal(
      (await fetchAs('/api/faces/face-1/thumbnail', viewer)).status,
      404,
    )
    assert.equal(
      (await fetchAs('/api/people/private-person', viewer)).status,
      404,
    )
    assert.deepEqual((await jsonAs('/api/people', viewer)).people, [])
  }
  assert.equal((await fetchAs('/api/faces/face-1/thumbnail', 1)).status, 200)
  assert.equal((await fetchAs('/api/people/private-person', 1)).status, 200)
})

test('embedded LivePhoto video bytes cannot bypass the photo permission', async () => {
  folder(10, 'live', 'login')
  const row = await photo('live-photo', 'live/photo.jpg', {
    isLivePhoto: 1,
    livePhotoVideoKey: `embedded:${jpeg.length}`,
    livePhotoVideoUrl: '/api/photos/live-photo/motion-video',
  })
  const clip = Buffer.from('test-video-bytes')
  await runtime.write('library/live/photo.jpg', Buffer.concat([jpeg, clip]))
  assert.equal(
    (await fetchAs('/api/photos/live-photo/motion-video')).status,
    404,
  )
  const response = await fetchAs('/api/photos/live-photo/motion-video', 2)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), clip)
  const detail = await jsonAs('/api/photos/live-photo/livephoto', 2)
  assert.equal(detail.originalUrl, row.originalUrl)
})

test('photo selectors require admin and paginate through all candidates with stable cursors', async () => {
  runtime.db
    .insert(tables.collections)
    .values({ id: 40, kind: 'person', title: 'person' })
    .run()
  runtime.db
    .insert(tables.people)
    .values({ id: 'person', collectionId: 40, origin: 'manual' })
    .run()
  runtime.db
    .insert(tables.photos)
    .values(
      Array.from({ length: 105 }, (_, index) => ({
        id: `photo-${String(index).padStart(3, '0')}`,
        title: 'same date',
        dateTaken: index < 80 ? '2026-10-01' : null,
      })),
    )
    .run()
  const options = (cursor = '') => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personId: 'person', cursor }),
  })
  assert.equal(
    (await fetchAs('/api/people/photo-search', null, options())).status,
    401,
  )
  assert.equal(
    (await fetchAs('/api/people/photo-search', 2, options())).status,
    403,
  )
  const ids = []
  let cursor = ''
  do {
    const result = await jsonAs('/api/people/photo-search', 1, options(cursor))
    assert(result.photos.length <= 48)
    ids.push(...result.photos.map((row) => row.id))
    cursor = result.nextCursor
  } while (cursor)
  assert.equal(ids.length, 105)
  assert.equal(new Set(ids).size, 105)
})

test('password login without 2FA still creates a session and normal profile access works', async () => {
  const response = await fetchAs('/api/login', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'user-2@example.test',
      password: 'test-password',
    }),
  })
  assert.equal(response.status, 201)
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('test_session=2'))
    ?.split(';')[0]
  assert(cookie)
  const profile = await jsonAs('/api/profile', null, { cookie })
  assert.equal(profile.id, 2)
  assert.equal(profile.isAdmin, false)
  assert.equal('password' in profile, false)
})

test('installation APIs remain closed after setup', async () => {
  const response = await fetchAs('/api/wizard/submit', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 403)
})

test('frontend guards keep normal users out of dashboard without a login redirect loop', async () => {
  globalThis.defineNuxtRouteMiddleware = (handler) => handler
  globalThis.navigateTo = (target) => target
  let current = {
    loggedIn: { value: true },
    user: { value: { id: 2, isAdmin: false } },
  }
  globalThis.useUserSession = () => current
  const { pathToFileURL } = await import('node:url')
  const { projectRoot } = await import('./test-utils/security-runtime.mjs')
  const adminGuard = (
    await import(
      pathToFileURL(path.join(projectRoot, 'app/middleware/admin.global.ts'))
    )
  ).default
  const guestGuard = (
    await import(
      pathToFileURL(path.join(projectRoot, 'app/middleware/guest.ts'))
    )
  ).default
  assert.equal(adminGuard({ path: '/dashboard/photos' }), '/')
  assert.equal(guestGuard({ path: '/login' }), '/')
  current = {
    loggedIn: { value: true },
    user: { value: { id: 1, isAdmin: true } },
  }
  assert.equal(adminGuard({ path: '/dashboard/photos' }), undefined)
  current = { loggedIn: { value: false }, user: { value: null } }
  assert.deepEqual(
    adminGuard({
      path: '/dashboard/photos',
      fullPath: '/dashboard/photos?x=1',
    }),
    { path: '/login', query: { redirect: '/dashboard/photos?x=1' } },
  )
})

test('identity changes clear cached images and prevent pending old requests from repopulating them', async (context) => {
  const { ImageLoaderManager, clearImageLoaderCache } =
    await import('../app/libs/image-loader-manager.ts')
  const originalXHR = globalThis.XMLHttpRequest
  const requests = []
  let automatic = true
  let responseStatus = 200
  let bytes = jpeg
  globalThis.XMLHttpRequest = class {
    status = responseStatus
    response = new Blob([bytes], { type: 'image/jpeg' })
    open() {}
    send() {
      requests.push(this)
      if (automatic) queueMicrotask(() => this.onload())
    }
    abort() {
      this.onabort?.()
    }
  }
  context.after(() => {
    clearImageLoaderCache()
    globalThis.XMLHttpRequest = originalXHR
  })
  clearImageLoaderCache()
  const first = await new ImageLoaderManager().loadImage('/private.jpg')
  assert(first.blobSrc.startsWith('blob:'))
  const count = requests.length
  await new ImageLoaderManager().loadImage('/private.jpg')
  assert.equal(requests.length, count)
  clearImageLoaderCache()
  responseStatus = 404
  await assert.rejects(new ImageLoaderManager().loadImage('/private.jpg'))
  automatic = false
  responseStatus = 200
  const pending = new ImageLoaderManager().loadImage('/pending-private.jpg')
  clearImageLoaderCache()
  requests.at(-1).onload()
  await assert.rejects(pending, /context changed/)
  const prefetch = new ImageLoaderManager().prefetch('/pending-prefetch.jpg')
  clearImageLoaderCache()
  await requests.at(-1).onload()
  assert.equal(await prefetch, false)
  automatic = true
  bytes = Buffer.from('not-an-image')
  await assert.rejects(
    new ImageLoaderManager().loadImage('/invalid-image.jpg'),
    /Invalid image/,
  )
})

test('equal legacy password hashes still preserve independent directory boundaries', async () => {
  folder(10, '', 'public', 'same-legacy-hash')
  folder(11, 'child', 'public', 'same-legacy-hash')
  const row = await photo('child-photo', 'child/photo.jpg')
  const rootCookie = scanCookie('', 'same-legacy-hash')
  const page = await jsonAs('/api/albums/scan/1?path=child', null, {
    cookie: rootCookie,
  })
  assert.equal(page.authorized, false)
  assert.equal(
    (await fetchAs(row.originalUrl, null, { cookie: rootCookie })).status,
    404,
  )
  const ownCookie = scanCookie('child', 'same-legacy-hash')
  const ownPage = await jsonAs('/api/albums/scan/1?path=child', null, {
    cookie: ownCookie,
  })
  assert.equal(ownPage.authorized, true)
  assert.equal(
    (await fetchAs(row.originalUrl, null, { cookie: ownCookie })).status,
    200,
  )
})

test('manual album covers and photo album summaries do not expose excluded photo identifiers', async () => {
  manual(20)
  manual(21, 'admin')
  const visible = await photo('visible-photo')
  const hidden = await photo('hidden-photo')
  runtime.db
    .insert(tables.collectionPhotos)
    .values([
      { collectionId: 20, photoId: visible.id },
      { collectionId: 20, photoId: hidden.id },
      { collectionId: 21, photoId: hidden.id },
    ])
    .run()
  runtime.db
    .update(tables.collections)
    .set({ coverPhotoId: hidden.id })
    .where(globalThis.eq(tables.collections.id, 20))
    .run()
  const albums = await jsonAs('/api/albums')
  const album = albums.find((item) => item.id === 20)
  assert.equal(album.coverPhotoId, visible.id)
  assert.equal(JSON.stringify(album).includes(hidden.id), false)
  const detail = await jsonAs('/api/albums/album-uid-20')
  assert.equal(detail.coverPhotoId, visible.id)
  assert.equal(JSON.stringify(detail).includes(hidden.id), false)
  const summaries = await jsonAs(`/api/photos/${visible.id}/albums`)
  assert.equal(
    summaries.find((item) => item.id === 20).coverPhotoId,
    visible.id,
  )
  assert.equal(JSON.stringify(summaries).includes(hidden.id), false)
})
