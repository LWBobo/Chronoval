import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, ref, watch, nextTick } from 'vue'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = createRequire(require.resolve('vue/package.json'))('@vue/compiler-sfc')
const filename = new URL('../app/components/ControlledUploadPanel.vue', import.meta.url).pathname
const { descriptor, errors } = parse(readFileSync(new URL('../app/components/ControlledUploadPanel.vue', import.meta.url), 'utf8'), { filename })
assert.deepEqual(errors, [])
const script = compileScript(descriptor, { id: 'controlled-upload-regression' })
const commonjs = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const componentCode = commonjs(script.content)
const utilityCode = commonjs(readFileSync(new URL('../app/utils/controlled-upload.ts', import.meta.url), 'utf8'))
const idCode = commonjs(readFileSync(new URL('../app/utils/client-id.ts', import.meta.url), 'utf8'))
// Model an ordinary HTTP browser: secure randomness exists, randomUUID does not.
const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
function loadUtilities(crypto = httpCrypto) {
  const ids = {}
  runInNewContext(idCode, { exports: ids, crypto })
  const exports = {}
  runInNewContext(utilityCode, { exports, require: name => { assert.equal(name, './client-id'); return ids } })
  return exports
}
function panel({ props = {}, fetch = async () => { throw new Error('Unexpected request') }, upload = async () => {}, crypto = httpCrypto, utilities = {} } = {}) {
  const exports = {}, events = []
  runInNewContext(componentCode, {
    exports,
    require: name => name === '~/utils/controlled-upload' ? { ...loadUtilities(crypto), putUploadPart: upload, ...utilities } : require(name),
    ref, computed, watch, AbortController, DOMException, crypto,
    useI18n: () => ({ t: key => key }),
    useUserSession: () => ({ user: ref({ id: 2, username: 'bobo' }) }),
    onMounted() {}, onBeforeUnmount() {},
    $fetch: fetch,
  })
  return { state: exports.default.setup(props, { expose() {}, emit: event => events.push(event) }), events }
}
const image = (name, relativePath = '') => ({ name, webkitRelativePath: relativePath, type: 'image/jpeg', size: 1234 })

test('HTTP uploads use distinct secure IDs without randomUUID', () => {
  assert.equal(httpCrypto.randomUUID, undefined)
  const { createUploadId } = loadUtilities()
  const ids = Array.from({ length: 1000 }, createUploadId)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[a-f0-9]{32}$/)
})

test('upload component template compiles with the styled file chooser', () => {
  const result = compileTemplate({ id: 'controlled-upload-regression', filename, source: descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(result.errors, [])
})

test('ten HTTP uploads create sessions, upload files and finalize with at most three active tasks', async () => {
  const requests = [], sent = [], sessions = new Map()
  let active = 0, peak = 0
  const { state, events } = panel({
    async fetch(url, options) {
      requests.push({ url, options })
      if (url === '/api/uploads/sessions') {
        const input = options.body
        const session = { id: input.idempotencyKey, state: 'created', parts: input.parts.map(part => ({ role: part.role, url: `/parts/${input.idempotencyKey}/${part.role}` })) }
        sessions.set(session.id, session)
        peak = Math.max(peak, ++active)
        await new Promise(resolve => setImmediate(resolve))
        return session
      }
      const id = url.split('/')[4]
      assert(sessions.has(id))
      assert(url.endsWith('/complete'))
      active--
      return { ...sessions.get(id), state: 'committed', photo: { status: 'ready' }, photoId: id }
    },
    async upload(file, url, progress, signal) {
      sent.push({ file, url })
      assert.equal(signal.aborted, false)
      progress(50)
      await new Promise(resolve => setImmediate(resolve))
      progress(100)
    },
  })
  const files = Array.from({ length: 10 }, (_, i) => image(`${i}.jpg`, `holiday/${i}.jpg`))
  state.selectFiles({ target: { files } })
  state.visibility.value = 'public'
  state.fileInput.value = { value: 'C:\\fakepath\\0.jpg' }
  await state.submit()
  assert.equal(requests.length, 20)
  assert.equal(sent.length, 10)
  assert.equal(peak, 3)
  assert.equal(state.running.value, false)
  assert.equal(state.error.value, '')
  assert.equal(state.selected.value.length, 0)
  assert.equal(state.fileInput.value.value, '')
  assert.equal(events.length, 10)
  assert.equal(state.items.value.length, 10)
  for (const item of state.items.value) {
    assert.equal(item.status, 'success')
    assert.equal(item.percentage, 100)
    assert.equal(item.upload.visibility, 'public')
    assert.match(item.upload.parts[0].relativePath, /^holiday\/\d+\.jpg$/)
    assert.equal(item.upload.parts[0].size, 1234)
  }
})

test('pre-request failures display an error, keep selected files and release the upload button', async () => {
  let requests = 0
  const { state } = panel({ crypto: undefined, fetch: async () => { requests++ }, utilities: { createUploadId() { throw new Error('Random generator unavailable') } } })
  state.selected.value = [image('original.jpg')]
  await state.submit()
  assert.equal(requests, 0)
  assert.equal(state.error.value, 'Random generator unavailable')
  assert.equal(state.selected.value.length, 1)
  assert.equal(state.items.value.length, 0)
  assert.equal(state.running.value, false)
})

test('request failures appear on their upload tasks and can be retried', async () => {
  let fail = true, requests = 0
  const { state } = panel({
    async fetch(url) {
      requests++
      if (fail) throw new Error('Storage unavailable')
      return { id: 'session', state: 'committed', photoId: 'photo', photo: { status: 'ready' } }
    },
  })
  state.selected.value = [image('original.jpg')]
  await state.submit()
  const item = state.items.value[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.error, 'Storage unavailable')
  assert.equal(state.running.value, false)
  assert.equal(item.files.length, 1)
  fail = false
  await state.retry(item)
  assert.equal(requests, 2)
  assert.equal(item.status, 'success')
})

test('invalid Live Photo pairs and recipient selection show errors before creating sessions', async () => {
  const { state } = panel()
  state.selected.value = [image('original.jpg')]
  state.pair.value = true
  await state.submit()
  assert.equal(state.error.value, 'accounts.pairHint')
  assert.equal(state.running.value, false)
  state.visibility.value = 'shared'
  await state.submit()
  assert.equal(state.error.value, 'accounts.recipientRequired')
  assert.equal(state.items.value.length, 0)
})

test('folder selection changes discard files from the replaced native input', async () => {
  const { state } = panel()
  state.selected.value = [image('original.jpg')]
  state.folder.value = true
  await nextTick()
  assert.equal(state.selected.value.length, 0)
})
