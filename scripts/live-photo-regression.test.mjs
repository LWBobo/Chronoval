import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { effectScope, ref } from 'vue'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const filename = fileURLToPath(new URL(specifier, context.parentURL))
      if (existsSync(filename + '.ts'))
        return { url: pathToFileURL(filename + '.ts').href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { useLivePhotoSource } =
  await import('../app/composables/useLivePhotoSource.ts')
const { clearLivePhotoCache } =
  await import('../app/composables/useLivePhotoProcessor.ts')
let originalFetch
beforeEach(() => {
  originalFetch = globalThis.fetch
  clearLivePhotoCache()
})
afterEach(() => {
  clearLivePhotoCache()
  globalThis.fetch = originalFetch
})
const delayed = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const video = (body = 'video') =>
  new Response(body, { headers: { 'content-type': 'video/mp4' } })
const makePhoto = (id = 'a') => ({
  id,
  isLivePhoto: 1,
  livePhotoVideoUrl: '/' + id,
})

test('gallery and viewer have separate Blob URLs backed by one shared download', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return video()
  }
  const scope = effectScope()
  const [card, viewer] = scope.run(() => [
    useLivePhotoSource(ref(makePhoto())),
    useLivePhotoSource(ref(makePhoto())),
  ])
  const [cardUrl, viewerUrl] = await Promise.all([card.load(), viewer.load()])
  assert(cardUrl.startsWith('blob:'))
  assert(viewerUrl.startsWith('blob:'))
  assert.notEqual(cardUrl, viewerUrl)
  assert.equal(requests, 1)
  scope.stop()
  assert.equal(card.src.value, null)
  assert.equal(viewer.src.value, null)
})

test('closing or switching a photo during download cannot attach its late result', async () => {
  const pending = delayed()
  globalThis.fetch = async (url) =>
    url === '/a' ? pending.promise : video('b')
  const photo = ref(makePhoto())
  const enabled = ref(true)
  const scope = effectScope()
  const source = scope.run(() => useLivePhotoSource(photo, enabled))
  const old = source.load()
  photo.value = makePhoto('b')
  assert((await source.load()).startsWith('blob:'))
  const current = source.src.value
  pending.resolve(video('a'))
  assert.equal(await old, null)
  assert.equal(source.src.value, current)
  enabled.value = false
  assert.equal(source.src.value, null)
  scope.stop()
})

test('identity changes revoke every attached source and prevent late cache refill', async () => {
  globalThis.fetch = async () => video()
  const scope = effectScope()
  const source = scope.run(() => useLivePhotoSource(ref(makePhoto())))
  assert(await source.load())
  clearLivePhotoCache()
  assert.equal(source.src.value, null)
  const pending = delayed()
  globalThis.fetch = async () => pending.promise
  const loading = source.load()
  clearLivePhotoCache()
  pending.resolve(video())
  assert.equal(await loading, null)
  assert.equal(source.src.value, null)
  scope.stop()
})

test('unmount while a request is pending never allocates an object URL', async () => {
  const pending = delayed()
  globalThis.fetch = async () => pending.promise
  const scope = effectScope()
  const source = scope.run(() => useLivePhotoSource(ref(makePhoto())))
  const loading = source.load()
  scope.stop()
  pending.resolve(video())
  assert.equal(await loading, null)
  assert.equal(source.src.value, null)
})

test('decoder errors are visible without replacing the still photo or retaining errors on retry', async () => {
  globalThis.fetch = async () => video()
  const scope = effectScope()
  const source = scope.run(() => useLivePhotoSource(ref(makePhoto())))
  const url = await source.load()
  source.onError({ target: { currentSrc: url, error: { code: 4 } } })
  assert.match(source.processingState.value.error, /无法解码/)
  assert.equal(source.src.value, url)
  assert.equal(await source.load(), url)
  assert.equal(source.error.value, null)
  scope.stop()
})
