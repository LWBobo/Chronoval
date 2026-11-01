import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, reactive, ref, watch } from 'vue'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = createRequire(require.resolve('vue/package.json'))('@vue/compiler-sfc')
const h3 = createRequire(require.resolve('nuxt/package.json'))('h3')
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const commonjs = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
function load(file, globals = {}, imports = {}) {
  const exports = {}
  runInNewContext(commonjs(source(file)), { exports, require: name => imports[name] ?? require(name), ...globals })
  return exports
}

function browser({ modern, result = true, throws = false, modal = true, input = false } = {}) {
  const calls = [], children = [], ranges = []
  const host = { appendChild: area => { children.push(area); calls.push('append') } }
  class Input {
    selectionStart = 2
    selectionEnd = 4
    selectionDirection = 'backward'
    closest() { return modal ? host : null }
    focus() { calls.push('restoreFocus') }
    setSelectionRange(...args) { calls.push(['restoreInput', ...args]) }
  }
  class Textarea {}
  const active = input ? new Input() : { closest: () => modal ? host : null, focus: () => calls.push('restoreFocus') }
  const originalRange = { cloneRange: () => 'savedRange' }
  const selection = { rangeCount: 1, getRangeAt: () => originalRange, removeAllRanges: () => ranges.splice(0), addRange: range => ranges.push(range) }
  const area = { style: {}, setAttribute() {}, focus() { calls.push('focus') }, select() { calls.push('select') }, setSelectionRange() {}, remove() { children.splice(children.indexOf(this), 1); calls.push('remove') } }
  const document = {
    body: modal ? { appendChild() { throw new Error('Escaped modal focus trap') } } : host,
    activeElement: active,
    getSelection: () => selection,
    querySelector: () => null,
    createElement: tag => { assert.equal(tag, 'textarea'); return area },
    execCommand(command) { assert.equal(command, 'copy'); calls.push(['copy', area.value]); if (throws) throw new Error('Denied'); return result },
  }
  const api = load('app/utils/clipboard.ts', { navigator: modern ? { clipboard: { writeText: modern } } : {}, document, HTMLInputElement: Input, HTMLTextAreaElement: Textarea })
  return { ...api, calls, children, ranges }
}

test('HTTP without navigator.clipboard copies inside a modal and restores focus and selection', async () => {
  const env = browser({ input: true })
  await env.writeClipboard('http://photo.example/albums/abc')
  assert.deepEqual(env.calls.find(row => Array.isArray(row) && row[0] === 'copy'), ['copy', 'http://photo.example/albums/abc'])
  assert.deepEqual(env.calls.at(-1), ['restoreInput', 2, 4, 'backward'])
  assert.deepEqual(env.ranges, ['savedRange'])
  assert.equal(env.children.length, 0)
})

test('HTTP copy works outside a modal and preserves Unicode and newlines', async () => {
  const env = browser({ modal: false })
  await env.writeClipboard('照片\n<script src="http://example/share/embed.js"></script>')
  assert.match(env.calls.find(row => Array.isArray(row))[1], /^照片\n/)
  assert.equal(env.children.length, 0)
})

test('HTTPS uses the modern API without modifying the document', async () => {
  const writes = [], env = browser({ modern: async text => writes.push(text) })
  await env.writeClipboard('secret')
  assert.deepEqual(writes, ['secret'])
  assert.deepEqual(env.calls, [])
})

test('HTTPS clipboard rejection falls back to selection copying', async () => {
  const env = browser({ modern: async () => { throw new Error('Permission denied') } })
  await env.writeClipboard('fallback')
  assert.equal(env.calls.some(row => Array.isArray(row) && row[0] === 'copy'), true)
  assert.equal(env.children.length, 0)
})

for (const failure of [{ result: false }, { throws: true }]) {
  test(`copy failure cleans up and restores focus (${JSON.stringify(failure)})`, async () => {
    const env = browser(failure)
    await assert.rejects(env.writeClipboard('sensitive setup key'))
    assert.equal(env.children.length, 0)
    assert.equal(env.calls.at(-1), 'restoreFocus')
    assert.deepEqual(env.ranges, ['savedRange'])
  })
}

test('clipboard calls outside a browser reject clearly', async () => {
  const api = load('app/utils/clipboard.ts')
  await assert.rejects(api.writeClipboard('text'), /Clipboard unavailable/)
})

function component(file, { copy = async () => {}, fetch = async () => {}, props = {} } = {}) {
  const { descriptor, errors } = parse(source(`app/${file}`), { filename: file })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: file })
  const template = compileTemplate({ id: file, filename: file, source: descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const exports = {}, toasts = []
  runInNewContext(commonjs(script.content), {
    exports, require: name => {
      if (name === '~/utils/clipboard') return { writeClipboard: copy }
      if (name === '~/stores/settings') return { useSettingRef: () => ref('') }
      if (name === 'motion-v') return {}
      return require(name)
    },
    ref, computed, reactive, watch, $fetch: fetch, $t: key => key,
    useToast: () => ({ add: row => toasts.push(row) }), useGtag: () => ({ gtag() {} }),
    useHead() {}, definePageMeta() {}, defineShortcuts() {}, onMounted() {}, onUnmounted() {},
    useDayjs: () => () => {}, setTimeout: () => 1, clearTimeout() {},
    console: { error() {} }, window: { location: { origin: 'http://photo.example' } }, navigator: {},
  })
  return { state: exports.default.setup(props, { expose() {}, emit() {} }), toasts }
}

test('2FA copies the actual setup key through the HTTP-compatible helper', async () => {
  const writes = []
  const { state } = component('pages/dashboard/settings/security.vue', { copy: async text => writes.push(text) })
  state.setup.value = { secret: 'TESTKEY' }
  await state.copySecret()
  assert.deepEqual(writes, ['TESTKEY'])
  assert.equal(state.copied.value, true)
})

test('2FA copy and setup failures show visible errors and reset pending state', async () => {
  const { state, toasts } = component('pages/dashboard/settings/security.vue', { copy: async () => { throw new Error('Denied') }, fetch: async () => { throw new Error('Offline') } })
  state.setup.value = { secret: 'TESTKEY' }
  await state.copySecret()
  assert.equal(state.copied.value, false)
  assert.equal(toasts.at(-1).title, 'settings.security.twoFactor.copyFailed')
  await state.startSetup()
  assert.equal(state.enabling.value, false)
  assert.equal(toasts.at(-1).title, 'settings.security.twoFactor.setupError')
})

test('HTTP share links and embed code copy without the native share/clipboard APIs', async () => {
  const writes = []
  const { state, toasts } = component('components/photo/ShareModal.vue', { props: { isOpen: true, photo: { id: 'abc', title: 'Photo' } }, copy: async text => writes.push(text) })
  assert.equal(state.canUseNativeShare, false)
  await state.handleCopyLink(); await state.handleCopyEmbed()
  assert.equal(writes[0], 'http://photo.example/abc')
  assert.match(writes[1], /src="http:\/\/photo.example\/share\/embed.js"/)
  assert.equal(toasts.length, 2)
  assert.equal(toasts.every(row => row.color === 'success'), true)
})

test('share copy failure reports an error rather than success', async () => {
  const { state, toasts } = component('components/photo/ShareModal.vue', { props: { isOpen: true, photo: { id: 'abc' } }, copy: async () => { throw new Error('Denied') } })
  await state.handleCopyLink()
  assert.equal(state.isCopied.value, false)
  assert.equal(toasts.at(-1).color, 'error')
})

test('new security error messages exist in every supported locale', () => {
  for (const locale of ['zh-Hans', 'zh-Hant-HK', 'en']) {
    const messages = JSON.parse(source(`i18n/locales/${locale}.json`)).settings.security.twoFactor
    for (const key of ['setupError', 'copyFailed']) assert.equal(typeof messages[key], 'string')
  }
})

test('album editor script and template compile with the shared clipboard helper', () => {
  const file = 'app/components/AlbumEditSlideover.vue'
  const { descriptor, errors } = parse(source(file), { filename: file })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: file })
  const template = compileTemplate({ id: file, filename: file, source: descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  assert.match(script.content, /import \{ writeClipboard \} from '~\/utils\/clipboard'/)
})

test('cookies follow the trusted external protocol and honor configured overrides', () => {
  const env = {}
  const proxy = load('server/utils/trusted-proxy.ts', { process: { env } })
  const { useSecureCookie } = load('server/utils/cookie-security.ts', { process: { env } }, { h3, './trusted-proxy': proxy })
  const event = (encrypted, headers = {}, remoteAddress = '') => ({
    node: { req: { headers, socket: { encrypted, remoteAddress }, connection: { encrypted } } },
  })
  assert.equal(useSecureCookie(event(false)), false)
  assert.equal(useSecureCookie(event(true)), true)
  assert.equal(useSecureCookie(event(false, { 'x-forwarded-proto': 'https' }, '10.0.0.8')), false)
  assert.equal(useSecureCookie(event(true, { 'x-forwarded-proto': 'http' }, '10.0.0.8')), true)
  env.NUXT_TRUST_PROXY_IPS = '192.168.31.2'
  assert.equal(useSecureCookie(event(false, { 'x-forwarded-proto': 'https' }, '192.168.31.2')), true)
  assert.equal(useSecureCookie(event(false, { 'x-forwarded-proto': 'https' }, '::ffff:192.168.31.2')), true)
  assert.equal(useSecureCookie(event(false, { 'x-forwarded-proto': 'http' }, '192.168.31.2')), false)
  assert.equal(useSecureCookie(event(false, { 'x-forwarded-proto': 'https' }, '192.168.31.3')), false)
  env.NUXT_COOKIE_SECURE = 'true'; assert.equal(useSecureCookie(event(false)), true)
  env.NUXT_COOKIE_SECURE = 'false'; assert.equal(useSecureCookie(event(true)), false)
})

test('request origin keeps HTTP unless the proxy address is trusted', () => {
  const env = { NUXT_TRUST_PROXY_IPS: '192.168.31.2' }
  const { resolveRequestOrigin } = load('server/utils/site-url.ts', { process: { env } }, {
    h3,
    '../services/settings/settingsManager': { settingsManager: { get: async () => '' } },
    './trusted-proxy': load('server/utils/trusted-proxy.ts', { process: { env } }),
  })
  const event = (peer, protocol) => h3.createEvent({
    method: 'GET', url: '/photo/abc',
    headers: { host: 'internal:3000', 'x-forwarded-host': 'photo.example', 'x-forwarded-proto': protocol },
    socket: { remoteAddress: peer, encrypted: false }, connection: { encrypted: false },
  }, {})
  assert.equal(resolveRequestOrigin(event('192.168.31.2', 'http')), 'http://photo.example')
  assert.equal(resolveRequestOrigin(event('::ffff:192.168.31.2', 'https')), 'https://photo.example')
  assert.equal(resolveRequestOrigin(event('192.168.31.3', 'https')), 'http://internal:3000')
})

test('site-config init waits for the configured HTTP origin before publishing it', async () => {
  const env = {}
  let configured = 'http://photo.example:3100'
  let hookGet = () => Promise.resolve(configured)
  let plugin
  const siteUrl = load('server/utils/site-url.ts', { process: { env } }, {
    h3,
    '../services/settings/settingsManager': { settingsManager: { get: async () => configured } },
    './trusted-proxy': load('server/utils/trusted-proxy.ts', { process: { env } }),
  })
  load('server/plugins/7.site-url.ts', {
    process: { env }, console,
    defineNitroPlugin: (fn) => { plugin = fn; return fn },
    useRuntimeConfig: () => ({ public: {} }),
  }, {
    '../services/settings/settingsManager': { settingsManager: { get: () => hookGet() } },
    '../utils/site-url': siteUrl,
  })
  let init
  await plugin({ hooks: { hook: (name, fn) => { if (name === 'site-config:init') init = fn } } })
  let release
  hookGet = () => new Promise((resolve) => { release = resolve })
  const ctx = {
    siteConfig: { entries: [], push(input) { this.entries.push(input) } },
    event: h3.createEvent({
      method: 'GET', url: '/',
      headers: { host: '192.168.1.5:3100' },
      socket: { remoteAddress: '192.168.1.8', encrypted: false }, connection: { encrypted: false },
    }, {}),
  }
  ctx.event.context.siteConfigNitroOrigin = 'https://192.168.1.5:3100/'
  const done = init(ctx)
  let settled = false
  done.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(ctx.siteConfig.entries.length, 0)
  release(configured)
  await done
  assert.equal(settled, true)
  assert.equal(ctx.event.context.siteConfigNitroOrigin, 'http://photo.example:3100')
  assert.equal(ctx.siteConfig.entries.length, 1)
  assert.equal(ctx.siteConfig.entries[0]._context, 'chronoval:app-site-url')
  assert.equal(ctx.siteConfig.entries[0]._priority, 1)
  assert.equal(ctx.siteConfig.entries[0].url, 'http://photo.example:3100')

  configured = ''
  hookGet = () => Promise.resolve(configured)
  const unconfigured = {
    siteConfig: { entries: [], push(input) { this.entries.push(input) } },
    event: h3.createEvent({
      method: 'GET', url: '/',
      headers: { host: '192.168.1.5:3100' },
      socket: { remoteAddress: '192.168.1.8', encrypted: false }, connection: { encrypted: false },
    }, {}),
  }
  await init(unconfigured)
  assert.equal(unconfigured.event.context.siteConfigNitroOrigin, 'http://192.168.1.5:3100')
  assert.equal(unconfigured.siteConfig.entries[0]._context, 'chronoval:request-origin')
})

test('CSRF accepts same-origin HTTP and HTTPS while rejecting foreign origins and wrong tokens', async () => {
  const { assertCsrf } = load('server/utils/csrf.ts', {
    Buffer, URL, process: { env: {} }, getUserSession: async () => ({ csrfToken: 'valid-token', user: { id: 1 } }),
    getRequestHeader: h3.getRequestHeader, getRequestURL: h3.getRequestURL, createError: h3.createError,
  }, { './site-url': { resolveSiteUrl: async () => 'https://canonical.example' } })
  const event = (secure, origin, token = 'valid-token') => h3.createEvent({ method: 'POST', url: '/api/me/photos/visibility-batch', headers: { host: 'photo.example:3100', origin, 'x-csrf-token': token }, socket: { encrypted: secure }, connection: { encrypted: secure } }, {})
  await assertCsrf(event(false, 'http://photo.example:3100'))
  await assertCsrf(event(true, 'https://photo.example:3100'))
  await assertCsrf(event(false, 'https://canonical.example'))
  await assert.rejects(assertCsrf(event(false, 'http://foreign.example')), error => error.statusCode === 403)
  await assert.rejects(assertCsrf(event(false, 'http://photo.example:3100', 'wrong')), error => error.statusCode === 403)
})

test('CSRF recognizes HTTP/HTTPS proxy origins only from explicitly trusted proxy addresses', async () => {
  const env = { NUXT_TRUST_PROXY_IPS: '192.168.31.2' }
  const { assertCsrf } = load('server/utils/csrf.ts', {
    Buffer, URL, process: { env }, getUserSession: async () => ({ csrfToken: 'valid-token', user: { id: 1 } }),
    getRequestHeader: h3.getRequestHeader, getRequestURL: h3.getRequestURL, createError: h3.createError,
  }, { './site-url': { resolveSiteUrl: async () => 'http://photo.example' } })
  const event = (peer, protocol, origin, token = 'valid-token') => h3.createEvent({
    method: 'POST', url: '/api/me/photos/visibility-batch',
    headers: { host: 'internal:3000', origin, 'x-csrf-token': token, 'x-forwarded-host': 'photo.example', 'x-forwarded-proto': protocol },
    socket: { remoteAddress: peer, encrypted: false }, connection: { encrypted: false },
  }, {})
  await assertCsrf(event('192.168.31.2', 'https', 'https://photo.example'))
  await assertCsrf(event('::ffff:192.168.31.2', 'https', 'https://photo.example'))
  await assertCsrf(event('192.168.31.2', 'http', 'http://photo.example'))
  await assert.rejects(assertCsrf(event('192.168.31.3', 'https', 'https://photo.example')), error => error.statusCode === 403)
  await assert.rejects(assertCsrf(event('192.168.31.2', 'https', 'https://foreign.example')), error => error.statusCode === 403)
  await assert.rejects(assertCsrf(event('192.168.31.2', 'https', 'https://photo.example', 'wrong')), error => error.statusCode === 403)
  env.NUXT_TRUST_PROXY_IPS = ''
  await assert.rejects(assertCsrf(event('', 'https', 'https://photo.example')), error => error.statusCode === 403)
})

// Run the existing logout/login cookie regression cases through the same TS loader.
load('server/utils/session-cookie.test.ts', {}, { './session-cookie.ts': load('server/utils/session-cookie.ts') })
