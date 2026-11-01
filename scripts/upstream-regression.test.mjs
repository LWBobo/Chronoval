import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createRequire } from 'node:module'
import { readFile, mkdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { createSecurityRuntime } from './test-utils/security-runtime.mjs'
import * as tables from '../server/database/schema.ts'

let runtime
let scannerModule
let livePhoto
let scannerState
const admin = { cookie: 'test_session=1', 'x-csrf-token': 'test-csrf-token' }
const member = { cookie: 'test_session=2' }
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const scannerURL = new URL(
  '../server/services/library/scanner.ts',
  import.meta.url,
).href
const managerURL = new URL(
  '../server/services/pipeline-queue/manager.ts',
  import.meta.url,
).href
const liveURL = new URL(
  '../server/services/library/live-photo.ts',
  import.meta.url,
).href
const fixtureModules = {
  '../scan-library/manager': `
    export const getAllScalableMounts = () => globalThis.__chronovalScannerTest.mounts;
    export const markScanMountUnavailable = () => {};
    export const unmarkScanMountUnavailable = () => {};
    export const recordScanResult = () => {};
  `,
  './ffmpeg':
    'export const probeVideo = () => {}; export const extractVideoFrame = () => {};',
  '../image/thumbnail': 'export const generateThumbnailAndHash = () => {};',
  '../image/processor':
    'export const preprocessImageBuffer = () => {}; export const preprocessImageWithJpegUpload = () => {}; export const processImageMetadataAndSharp = () => {};',
  '../image/exif':
    'export const extractExifData = () => {}; export const extractPhotoInfo = () => {};',
  '../location/geocoding':
    'export const parseGPSCoordinates = () => {}; export const extractLocationFromGPS = () => {};',
  '../ml/enqueue':
    'export const enqueueMlJobsForPhoto = async id => { globalThis.__chronovalScannerTest.ml.push(id) };',
}
const moduleFixtures = [
  { parentURL: scannerURL, specifiers: { ...fixtureModules, sharp: 'export default function sharp() { throw new Error("Unexpected native image decoding in scanner control-flow tests") }' } },
  { parentURL: managerURL, specifiers: fixtureModules },
  { parentURL: liveURL, specifiers: { '../video/motion-photo': 'export const locateEmbeddedMotionVideo = () => null;' } },
]

const request = (route, options = {}) => fetch(runtime.origin + route, options)
const job = (
  status = 'failed',
  payload = {
    type: 'library-file',
    mount: 'scan_1',
    libraryPath: 'photo.jpg',
  },
) =>
  runtime.db
    .insert(tables.pipelineQueue)
    .values({ status, payload })
    .returning()
    .get()
const getJob = (id) =>
  runtime.db
    .select()
    .from(tables.pipelineQueue)
    .where(eq(tables.pipelineQueue.id, id))
    .get()
const scanner = () => new scannerModule.LibraryScanner()
const photoId = (rel) => scannerModule.buildLibraryPhotoId('scan_1', rel)
const entry = (rel, extra = {}) => ({
  source: 'library',
  type: 'image',
  libraryId: 1,
  fixedProviderId: 1,
  fileSize: statSync(path.join(runtime.scratch, 'library', rel)).size,
  lastModified: statSync(path.join(runtime.scratch, 'library', rel)).mtime.toISOString(),
  libraryMount: 'scan_1',
  libraryPath: rel,
  originalUrl: `/library/scan_1/${rel}`,
  title: rel,
  thumbnailUrl: '/storage/thumb.webp',
  ...extra,
})

before(async () => {
  runtime = await createSecurityRuntime({ moduleFixtures })
  runtime.db
    .insert(tables.users)
    .values([
      {
        id: 1,
        username: 'admin', usernameKey: 'admin', displayName: 'Administrator', emailKey: 'admin@example.test', mustChangePassword: false,
        email: 'admin@example.test',
        role: 'admin',
          createdAt: new Date(),
      },
      {
        id: 2,
        username: 'member', usernameKey: 'member', displayName: 'Member', emailKey: 'member@example.test', mustChangePassword: false,
        email: 'member@example.test',
        role: 'user',
          createdAt: new Date(),
      },
    ])
    .run()
  await runtime.mount(
    '/api/queue/task/list',
    'server/api/queue/task/list.get.ts',
  )
  await runtime.mount(
    '/api/queue/failed/:taskId',
    'server/api/queue/failed/[taskId].delete.ts',
    'delete',
  )
  await runtime.mount(
    '/api/queue/task/retry',
    'server/api/queue/task/retry.post.ts',
    'post',
  )
  await runtime.mount(
    '/api/queue/task/retry-batch',
    'server/api/queue/task/retry-batch.post.ts',
    'post',
  )
  scannerState = { mounts: [], ml: [] }
  globalThis.__chronovalScannerTest = scannerState
  scannerModule = await import('../server/services/library/scanner.ts')
  livePhoto = await import('../server/services/library/live-photo.ts')
})

beforeEach(async () => {
  runtime.db.delete(tables.pipelineQueue).run()
  runtime.db.delete(tables.photoFiles).run()
  runtime.db.delete(tables.photos).run()
  const root = path.join(runtime.scratch, 'library')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  scannerState.mounts = [
    {
      name: 'scan_1',
      root,
      type: 'image',
      routePrefix: '/library/scan_1',
      extensions: new Set(['.jpg', '.mov']),
    },
  ]
  scannerState.ml = []
  runtime.db.delete(tables.libraries).run()
  runtime.db.delete(tables.settingsStorageProviders).run()
  runtime.db.insert(tables.libraries).values({ id: 1, name: 'fixture', rootPath: root }).run()
  runtime.db.insert(tables.settingsStorageProviders).values({ id: 1, name: 'fixture', provider: 'local', config: { provider: 'local', basePath: path.join(runtime.scratch, 'storage'), prefix: 'photos', baseUrl: '/storage' } }).run()
  runtime.state.provider = { config: runtime.db.select().from(tables.settingsStorageProviders).get().config }
  runtime.state.libraries = runtime.db.select().from(tables.libraries).all()
  globalThis.__workerPool = {
    addTask: async (payload, options) => {
      const task = runtime.db
        .insert(tables.pipelineQueue)
        .values({
          payload,
          maxAttempts: options?.maxAttempts ?? 3,
        })
        .returning()
        .get()
      return task.id
    },
  }
})

after(async () => {
  delete globalThis.__workerPool
  delete globalThis.__chronovalScannerTest
  await runtime?.close()
})

test('queue administration requires an actual administrator', async () => {
  const task = job()
  for (const headers of [{}, member]) {
    const status = headers.cookie ? 403 : 401
    assert.equal(
      (await request('/api/queue/task/list', { headers })).status,
      status,
    )
    assert.equal(
      (
        await request(`/api/queue/failed/${task.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
      status,
    )
  }
  assert(getJob(task.id))
})

test('only failed jobs can be individually deleted', async () => {
  for (const status of ['pending', 'in-stages', 'completed']) {
    const task = job(status)
    assert.equal(
      (
        await request(`/api/queue/failed/${task.id}`, {
          method: 'DELETE',
          headers: admin,
        })
      ).status,
      400,
    )
    assert(getJob(task.id))
  }
  const failed = job()
  assert.equal(
    (
      await request(`/api/queue/failed/${failed.id}`, {
        method: 'DELETE',
        headers: admin,
      })
    ).status,
    200,
  )
  assert.equal(getJob(failed.id), undefined)
  assert.equal(
    (
      await request(`/api/queue/failed/${failed.id}`, {
        method: 'DELETE',
        headers: admin,
      })
    ).status,
    404,
  )
})

test('failed-job deletion validates complete positive numeric IDs', async () => {
  for (const id of ['1junk', '-1', '0', '1.5', 'NaN', '9007199254740992'])
    assert.equal(
      (
        await request(`/api/queue/failed/${id}`, {
          method: 'DELETE',
          headers: admin,
        })
      ).status,
      400,
    )
})

test('library and ML filters retain pagination and independent status counts', async () => {
  job('failed')
  job('pending')
  job('failed', { type: 'photo-ocr', photoId: 'ml-photo' })
  let response = await request(
    '/api/queue/task/list?type=library-file&limit=1&offset=1',
    { headers: admin },
  )
  assert.equal(response.status, 200)
  let data = await response.json()
  assert.equal(data.total, 2)
  assert.equal(data.data.length, 1)
  assert.equal(data.data[0].payload.type, 'library-file')
  assert.equal(data.statusCounts.failed, 1)
  assert.equal(data.statusCounts.pending, 1)
  response = await request('/api/queue/task/list?type=photo-ocr', {
    headers: admin,
  })
  data = await response.json()
  assert.equal(data.total, 1)
  assert.equal(data.data[0].payload.type, 'photo-ocr')
})

test('single retry preserves library payload and resets its status', async () => {
  const task = job()
  const response = await request('/api/queue/task/retry', {
    method: 'POST',
    headers: { ...admin, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: task.id }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).payload, task.payload)
  assert.equal(getJob(task.id).status, 'pending')
})

test('batch retry handles library and ML jobs together', async () => {
  const library = job()
  const ml = job('failed', { type: 'photo-ocr', photoId: 'ml-photo' })
  const response = await request('/api/queue/task/retry-batch', {
    method: 'POST',
    headers: { ...admin, 'content-type': 'application/json' },
    body: JSON.stringify({ retryAll: true }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).retriedCount, 2)
  assert.equal(getJob(library.id).status, 'pending')
  assert.equal(getJob(ml.id).status, 'pending')
})

test('single-file retry indexes and updates without replacing manual fields', async () => {
  await runtime.write('library/photo.jpg', 'photo')
  const worker = scanner()
  worker.processFileInner = async () => entry('photo.jpg')
  assert.equal(await worker.processSingleFile('scan_1', 'photo.jpg'), 'indexed')
  runtime.db
    .update(tables.photos)
    .set({ isPanorama: 1 })
    .where(eq(tables.photos.id, photoId('photo.jpg')))
    .run()
  worker.processFileInner = async () => entry('photo.jpg', { title: 'refreshed' })
  assert.equal(await worker.processSingleFile('scan_1', 'photo.jpg'), 'updated')
  const photo = runtime.db.select().from(tables.photos).get()
  assert.equal(photo.title, 'refreshed')
  assert.equal(photo.isPanorama, 1)
  assert.deepEqual(scannerState.ml, [photo.id, photo.id])
})

test('retry and full-scan insert races converge on one stable photo ID', async () => {
  await runtime.write('library/race.jpg', 'photo')
  const worker = scanner()
  worker.processFileInner = async () => {
    runtime.db
      .update(tables.photos)
      .set({ title: 'concurrent scan' })
      .where(eq(tables.photos.id, photoId('race.jpg')))
      .run()
    return entry('race.jpg', { title: 'retry result' })
  }
  await worker.processSingleFile('scan_1', './race.jpg')
  const photos = runtime.db.select().from(tables.photos).all()
  assert.equal(photos.length, 1)
  assert.equal(photos[0].title, 'retry result')
})

test('retry of a paired MOV updates the still and removes a standalone duplicate', async () => {
  await runtime.write('library/live.jpg', 'photo')
  await runtime.write('library/live.MOV', 'motion')
  runtime.db
    .insert(tables.photos)
    .values({
      id: photoId('live.MOV'),
      ...entry('live.MOV', { type: 'video' }),
    })
    .run()
  const worker = scanner()
  worker.processFileInner = async (mount, rel, absFile) => ({
    ...entry(rel),
    ...(await livePhoto.detectLibraryLivePhoto({
      photoId: photoId(rel),
      mountName: mount.name,
      rel,
      absFile,
      rawBuffer: Buffer.from('photo'),
    })),
  })
  await worker.processSingleFile('scan_1', 'live.MOV')
  const photos = runtime.db.select().from(tables.photos).all()
  assert.equal(photos.length, 1)
  assert.equal(photos[0].id, photoId('live.jpg'))
  assert.equal(photos[0].isLivePhoto, 1)
  assert.match(runtime.db.select().from(tables.photoFiles).where(eq(tables.photoFiles.role, 'live_video')).get().libraryPath, /live\.MOV$/)
})

test('retry rejects traversal, outside symlinks, missing files and unsupported entries', async () => {
  await runtime.write('outside.jpg', 'outside')
  await runtime.write('library/document.txt', 'unsupported')
  await symlink(
    path.join(runtime.scratch, 'outside.jpg'),
    path.join(runtime.scratch, 'library/escape.jpg'),
  )
  await mkdir(path.join(runtime.scratch, 'library/directory.jpg'))
  const worker = scanner()
  worker.processFileInner = async () => {
    throw new Error('Processing must not start')
  }
  for (const rel of [
    '../outside.jpg',
    '..\\outside.jpg',
    'escape.jpg',
    'missing.jpg',
    'document.txt',
    'directory.jpg',
  ])
    await assert.rejects(worker.processSingleFile('scan_1', rel))
  await assert.rejects(worker.processSingleFile('missing-mount', 'photo.jpg'))
  assert.equal(runtime.db.select().from(tables.photos).all().length, 0)
})

test('failed retry retains an unreadable file locator for retry and cleanup', async () => {
  await runtime.write('library/broken.jpg', 'broken')
  const worker = scanner()
  worker.processFileInner = async () => null
  await assert.rejects(
    worker.processSingleFile('scan_1', 'broken.jpg'),
    /Library processing failed/,
  )
  assert.equal(runtime.db.select().from(tables.photos).get().processingStatus, 'failed')
})

test('scan failures enter the queue and duplicate active or same-version failures are suppressed', async () => {
  await runtime.write('library/broken.jpg', 'broken')
  const worker = scanner()
  worker.processFileInner = async () => null
  assert.equal((await worker.scanMountByName('scan_1')).failed, 1)
  await worker.scanMountByName('scan_1')
  let tasks = runtime.db.select().from(tables.pipelineQueue).all()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].maxAttempts, 3)
  assert.equal(tasks[0].payload.type, 'library-file')
  runtime.db.update(tables.pipelineQueue).set({ status: 'failed' }).run()
  await worker.scanMountByName('scan_1')
  assert.equal(runtime.db.select().from(tables.pipelineQueue).all().length, 1)
  await worker.enqueueFailedFile(
    'scan_1',
    'broken.jpg',
    'new-version',
    'changed',
  )
  tasks = runtime.db.select().from(tables.pipelineQueue).all()
  assert.equal(tasks.length, 2)
})

test('failures without a known mtime are also deduplicated', async () => {
  const worker = scanner()
  job('failed', {
    type: 'library-file',
    mount: 'scan_1',
    libraryPath: 'missing.jpg',
  })
  await worker.enqueueFailedFile(
    'scan_1',
    'missing.jpg',
    undefined,
    'unavailable',
  )
  assert.equal(runtime.db.select().from(tables.pipelineQueue).all().length, 1)
})

const quiet = {
  withTag() {
    return this
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
  success() {},
}

test('queue worker dispatches a library retry and marks it completed', async () => {
  await runtime.write('library/worker.jpg', 'photo')
  const task = job('in-stages', {
    type: 'library-file',
    mount: 'scan_1',
    libraryPath: 'worker.jpg',
  })
  const { QueueManager } =
    await import('../server/services/pipeline-queue/manager.ts')
  const worker = QueueManager.getInstance('upstream-success', quiet)
  worker.getNextTask = async () => getJob(task.id)
  const original = scannerModule.libraryScanner.processFileInner
  scannerModule.libraryScanner.processFileInner = async () => entry('worker.jpg')
  try {
    await worker.processNextTask()
    assert.equal(getJob(task.id).status, 'completed')
    assert.equal(runtime.db.select().from(tables.photos).all().length, 1)
  } finally {
    scannerModule.libraryScanner.processFileInner = original
  }
})

test('queue worker retains three-attempt backoff for a failed library retry', async () => {
  await runtime.write('library/worker-broken.jpg', 'broken')
  const task = job('in-stages', {
    type: 'library-file',
    mount: 'scan_1',
    libraryPath: 'worker-broken.jpg',
  })
  const { QueueManager } =
    await import('../server/services/pipeline-queue/manager.ts')
  const worker = QueueManager.getInstance('upstream-failure', quiet)
  worker.getNextTask = async () => getJob(task.id)
  const original = scannerModule.libraryScanner.processFileInner
  scannerModule.libraryScanner.processFileInner = async () => null
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await worker.processNextTask()
      const current = getJob(task.id)
      assert.equal(current.attempts, attempt)
      assert.equal(current.status, attempt === 3 ? 'failed' : 'pending')
      assert.match(current.errorMessage, /Library processing failed/)
    }
    assert.equal(runtime.db.select().from(tables.photos).get().processingStatus, 'failed')
  } finally {
    scannerModule.libraryScanner.processFileInner = original
  }
})

test('changed Vue components compile, including the new simple view', async () => {
  const requireFromVue = createRequire(import.meta.resolve('vue/package.json'))
  const { parse, compileScript, compileTemplate } =
    requireFromVue('@vue/compiler-sfc')
  for (const filename of [
    'app/components/albums/AlbumGallery.vue',
    'app/components/masonry/Root.vue',
    'app/components/masonry/SimpleView.vue',
    'app/pages/dashboard/queue.vue',
    'app/pages/login.vue',
  ]) {
    const source = await readFile(path.join(projectRoot, filename), 'utf8')
    const { descriptor, errors } = parse(source, { filename })
    assert.deepEqual(errors, [], filename)
    const script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({
      id: filename,
      filename,
      source: descriptor.template.content,
      compilerOptions: { bindingMetadata: script.bindings },
    })
    assert.deepEqual(template.errors, [], filename)
  }
})
