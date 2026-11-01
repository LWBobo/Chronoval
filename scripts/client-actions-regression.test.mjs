import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, reactive, ref, watch, nextTick } from 'vue'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = createRequire(require.resolve('vue/package.json'))('@vue/compiler-sfc')
const commonjs = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
const ids = {}
runInNewContext(commonjs(readFileSync(new URL('../app/utils/client-id.ts', import.meta.url), 'utf8')), { exports: ids, crypto: httpCrypto })
const compiled = new Map()
function compile(file) {
  if (!compiled.has(file)) {
    const filename = new URL(`../app/${file}`, import.meta.url).pathname
    const { descriptor, errors } = parse(readFileSync(new URL(`../app/${file}`, import.meta.url), 'utf8'), { filename })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: file })
    const template = compileTemplate({ id: file, filename, source: descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    compiled.set(file, commonjs(script.content))
  }
  return compiled.get(file)
}
function component(file, { props = {}, fetch = async () => { throw new Error('Unexpected request') } } = {}) {
  const exports = {}, events = []
  runInNewContext(compile(file), {
    exports,
    require: name => name === '~/utils/client-id' ? ids : require(name),
    crypto: httpCrypto, ref, computed, reactive, watch,
    useI18n: () => ({ t: key => key }),
    useUserSession: () => ({ user: ref({ id: 2, authVersion: 1 }) }),
    useRoute: () => ({ query: {} }),
    definePageMeta() {}, onMounted() {}, onBeforeUnmount() {},
    $fetch: fetch,
  })
  return { state: exports.default.setup(props, { expose() {}, emit: event => events.push(event) }), events }
}
const photo = (id, manage = true) => ({ id, aclVersion: 3, metadataVersion: 4, capabilities: { canManage: manage, canChangeVisibility: manage } })
const workspace = options => component('components/PhotoWorkspace.vue', { props: { mode: 'mine', admin: false }, ...options })

test('HTTP batch visibility saves all selected IDs and ACL versions without randomUUID', async () => {
  assert.equal(httpCrypto.randomUUID, undefined)
  const requests = []
  const { state, events } = component('components/PhotoVisibilityBatchPanel.vue', {
    props: { photos: [photo('a'), photo('b'), photo('c')] },
    fetch: async (url, options) => { requests.push({ url, body: options.body }) },
  })
  state.visibility.value = 'public'; state.confirmed.value = true
  await nextTick(); await state.save()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/me/photos/visibility-batch')
  assert.match(requests[0].body.operationId, /^[a-f0-9]{32}$/)
  assert.deepEqual(Array.from(requests[0].body.items, row => ({ ...row })), ['a', 'b', 'c'].map(id => ({ id, expectedAclVersion: 3 })))
  assert.equal(requests[0].body.visibility, 'public')
  assert.equal(requests[0].body.recipientIds.length, 0)
  assert.deepEqual(events, ['saved'])
  assert.equal(state.error.value, '')
  assert.equal(state.busy.value, false)
})

test('failed batch requests retain their operation ID on retry and get a new ID when inputs change', async () => {
  const requests = []; let fail = true
  const { state } = component('components/PhotoVisibilityBatchPanel.vue', {
    props: { photos: [photo('a')] },
    fetch: async (_url, options) => { requests.push(options.body); if (fail) throw new Error('Temporary failure') },
  })
  state.confirmed.value = true
  await nextTick(); await state.save()
  assert.equal(state.error.value, 'Temporary failure')
  assert.equal(state.busy.value, false)
  fail = false
  await state.save()
  assert.equal(requests[0].operationId, requests[1].operationId)
  state.visibility.value = 'shared'; state.recipientIds.value = [9]
  await nextTick(); await state.save()
  assert.notEqual(requests[2].operationId, requests[0].operationId)
  assert.deepEqual(Array.from(requests[2].recipientIds), [9])
})

test('batch visibility requires confirmation and preserves the administrator endpoint and reason', async () => {
  const requests = []
  const { state } = component('components/PhotoVisibilityBatchPanel.vue', {
    props: { admin: true, photos: [photo('a')] },
    fetch: async (url, options) => requests.push({ url, body: options.body }),
  })
  await state.save(); assert.equal(requests.length, 0)
  state.confirmed.value = true; state.reason.value = 'admin change'
  await nextTick(); await state.save()
  assert.equal(requests[0].url, '/api/admin/photos/visibility-batch')
  assert.equal(requests[0].body.reason, 'admin change')
})

test('select-all chooses only manageable loaded photos and enforces the 100-photo limit', () => {
  const { state } = workspace()
  state.items.value = [photo('foreign', false), ...Array.from({ length: 105 }, (_, i) => photo(String(i)))]
  state.selectAllPhotos()
  assert.equal(state.selectedIds.value.length, 100)
  assert.equal(state.selectedPhotos.value.length, 100)
  assert.equal(state.selectedIds.value.includes('foreign'), false)
  state.selectPhoto('104', true)
  assert.equal(state.selectedIds.value.includes('104'), false)
  state.selectPhoto('0', false); state.selectPhoto('104', true)
  assert.equal(state.selectedIds.value.length, 100)
  assert.equal(state.selectedIds.value.includes('104'), true)
  state.selectedIds.value = []; state.selectPhoto('foreign', true)
  assert.equal(state.selectedPhotos.value.length, 0)
})

test('select-all can include newly loaded photos and clear selection without changing photos', () => {
  const { state } = workspace()
  state.items.value = Array.from({ length: 50 }, (_, i) => photo(String(i)))
  state.selectAllPhotos(); assert.equal(state.selectedPhotos.value.length, 50)
  state.items.value = [...state.items.value, ...Array.from({ length: 50 }, (_, i) => photo(String(i + 50)))]
  state.selectAllPhotos(); assert.equal(state.selectedPhotos.value.length, 100)
  state.selectedIds.value = []
  assert.equal(state.selectedPhotos.value.length, 0)
  assert.equal(state.items.value.length, 100)
})

test('refresh removes missing or no-longer-manageable photos from the selection', async () => {
  const { state } = workspace({ fetch: async url => url === '/api/me/photos' ? { items: [photo('a'), photo('b', false)], nextCursor: null } : {} })
  state.items.value = [photo('a'), photo('b'), photo('c')]; state.selectAllPhotos()
  await state.load()
  assert.deepEqual(Array.from(state.selectedIds.value), ['a'])
})

test('HTTP batch lifecycle and ownership transfer dialogs generate valid operation IDs', async () => {
  const { state } = workspace()
  state.items.value = [photo('a'), photo('b')]; state.selectAllPhotos()
  state.prepareBatchAction('trash')
  assert.match(state.actionPhoto.value.operationId, /^[a-f0-9]{32}$/)
  assert.equal(state.actionPhoto.value.items.length, 2)
  assert.equal(state.actionPhoto.value.items[0].expectedVersion, 4)
  await state.beginTransfer(photo('a'))
  assert.match(state.transferKey.value, /^[a-f0-9]{32}$/)
})

test('HTTP collection batch permissions generate an operation ID and submit through the existing endpoint', async () => {
  const requests = []
  const { state, events } = component('components/CollectionBatchPanel.vue', {
    props: { collections: [{ collectionId: 1, title: 'album' }] },
    fetch: async (url, options) => {
      if (!options) return { aclVersion: 2, visibility: 'public', viewerIds: [], passwordExemptMode: 'none', passwordExemptUserIds: [] }
      requests.push({ url, body: options.body }); return { results: [{ collectionId: 1, success: true }] }
    },
  })
  state.selected.value = [1]; state.reason.value = 'batch change'
  await nextTick(); await state.save()
  assert.equal(requests[0].url, '/api/admin/collections/access/batch')
  assert.match(requests[0].body.operationId, /^[a-f0-9]{32}$/)
  assert.equal(requests[0].body.items[0].access.expectedAclVersion, 2)
  assert.deepEqual(events, ['saved'])
})

test('HTTP account action dialogs generate deletion IDs without randomUUID', () => {
  const { state } = component('pages/dashboard/users.vue')
  state.prepare('delete')
  assert.equal(state.pendingAction.value, 'delete')
  assert.match(state.deleteKey.value, /^[a-f0-9]{32}$/)
})

test('legacy photo management script and template compile after the request-ID fix', () => {
  compile('pages/dashboard/photos.vue')
})

test('selection labels are present in every supported locale', () => {
  for (const locale of ['zh-Hans', 'zh-Hant-HK', 'en']) {
    const { accounts } = JSON.parse(readFileSync(new URL(`../i18n/locales/${locale}.json`, import.meta.url), 'utf8'))
    for (const key of ['selectLoadedPhotos', 'clearPhotoSelection', 'photoSelectionHint']) assert.equal(typeof accounts[key], 'string')
  }
})
