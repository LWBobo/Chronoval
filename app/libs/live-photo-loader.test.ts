import assert from 'node:assert/strict'
import test from 'node:test'
import { LivePhotoLoader } from './live-photo-loader.ts'

const video = (body = 'video-bytes') =>
  new Response(body, { headers: { 'content-type': 'video/mp4' } })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('duplicate gallery/viewer loads share a download and reuse a complete MP4 Blob', async () => {
  const response = deferred<Response>()
  let requests = 0
  const loader = new LivePhotoLoader({
    fetch: async (_url, options) => {
      requests++
      assert.equal(options?.credentials, 'same-origin')
      assert.equal(options?.cache, 'no-cache')
      return response.promise
    },
  })
  const first = loader.load('/video', 'photo')
  const second = loader.load('/video', 'photo')
  assert.equal(first, second)
  response.resolve(video())
  const blob = await first
  assert(blob)
  assert.equal(blob.type, 'video/mp4')
  assert.equal(await blob.text(), 'video-bytes')
  assert.equal(await loader.load('/video', 'photo'), blob)
  assert.equal(requests, 1)
  assert.equal(loader.getState('photo')?.progress, 100)
})

test('failures are retryable and error responses are not cached as videos', async () => {
  let requests = 0
  const loader = new LivePhotoLoader({
    fetch: async () =>
      ++requests === 1 ? new Response('denied', { status: 403 }) : video(),
  })
  assert.equal(await loader.load('/video', 'photo'), null)
  assert.match(loader.getState('photo')!.error!, /403/)
  assert(await loader.load('/video', 'photo'))
  assert.equal(requests, 2)
  for (const response of [
    new Response('<html>login</html>', {
      headers: { 'content-type': 'text/html' },
    }),
    new Response(''),
    new Response('short', { headers: { 'content-length': '20' } }),
  ]) {
    const failed = new LivePhotoLoader({ fetch: async () => response })
    assert.equal(await failed.load('/video', 'p'), null)
    assert(failed.getState('p')?.error)
  }
})

test('timeouts cover stalled response bodies, not only response headers', async () => {
  const loader = new LivePhotoLoader({
    timeoutMs: 30,
    fetch: async (_url, options) =>
      new Response(
        new ReadableStream({
          start(controller) {
            options?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('timeout', 'AbortError')),
            )
          },
        }),
      ),
  })
  assert.equal(await loader.load('/video', 'photo'), null)
  assert.equal(loader.getState('photo')?.isProcessing, false)
})

test('size and cache limits preserve a valid download while keeping memory bounded', async () => {
  const tooLarge = new LivePhotoLoader({
    maxBytes: 3,
    fetch: async () => video('1234'),
  })
  assert.equal(await tooLarge.load('/video', 'photo'), null)
  let requests = 0
  const uncached = new LivePhotoLoader({
    cacheBytes: 1,
    fetch: async () => {
      requests++
      return video('1234')
    },
  })
  assert.equal((await uncached.load('/video', 'photo'))?.size, 4)
  assert.equal(uncached.states().size, 0)
  assert.equal((await uncached.load('/video', 'photo'))?.size, 4)
  assert.equal(requests, 2)
  const limited = new LivePhotoLoader({
    cacheEntries: 2,
    fetch: async () => video(),
  })
  for (const id of ['a', 'b', 'c']) await limited.load('/' + id, id)
  assert.equal(limited.states().size, 2)
})

test('clearing identity cancels active and queued work and discards late responses', async () => {
  const gate = deferred<Response>()
  const loader = new LivePhotoLoader({
    concurrency: 1,
    fetch: async () => gate.promise,
  })
  const active = loader.load('/active', 'a')
  const queued = loader.load('/queued', 'b')
  loader.clear()
  assert.equal(await active, null)
  assert.equal(await queued, null)
  gate.resolve(video())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(loader.states().size, 0)
})

test('URL changes for the same photo cannot restore an old response', async () => {
  const old = deferred<Response>()
  const loader = new LivePhotoLoader({
    fetch: async (url) => (url === '/old' ? old.promise : video('new')),
  })
  const previous = loader.load('/old', 'photo')
  const current = await loader.load('/new', 'photo')
  assert.equal(await current?.text(), 'new')
  assert.equal(await previous, null)
  old.resolve(video('old'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await loader.getState('photo')?.mp4Blob?.text(), 'new')
})

test('one background transfer leaves capacity for foreground playback and skips invisible queued work', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<Response>>>()
  const started: string[] = []
  const loader = new LivePhotoLoader({
    concurrency: 2,
    fetch: async (url) => {
      const key = String(url)
      started.push(key)
      const gate = deferred<Response>()
      gates.set(key, gate)
      return gate.promise
    },
  })
  const background = loader.load('/background', 'a', true)
  let visible = true
  const invisible = loader.load('/invisible', 'b', true, () => visible)
  const foreground = loader.load('/foreground', 'c')
  assert.deepEqual(started, ['/background', '/foreground'])
  visible = false
  gates.get('/background')!.resolve(video())
  gates.get('/foreground')!.resolve(video())
  assert(await background)
  assert(await foreground)
  assert.equal(await invisible, null)
  assert.equal(started.length, 2)
})
