import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createSecurityRuntime } from './test-utils/security-runtime.mjs'
import { users } from '../server/database/schema.ts'

const require = createRequire(import.meta.url)
const iconHandlerURL = pathToFileURL(realpathSync(
  require.resolve('@nuxt/icon/runtime/server/api.js'),
)).href
let runtime
let fallbackRequests = 0
const previousFetch = globalThis.$fetch

before(async () => {
  globalThis.__chronovalIconCollection = require('@iconify-json/lucide/icons.json')
  globalThis.$fetch = () => {
    fallbackRequests++
    throw new Error('Icon tests must not contact an external API')
  }
  runtime = await createSecurityRuntime({
    moduleFixtures: [{
      parentURL: iconHandlerURL,
      specifiers: {
        '#imports': 'export const useAppConfig = () => ({ icon: { fallbackToApi: false } }); export const defineCachedEventHandler = handler => handler;',
        '#nuxt-icon-server-bundle': 'export const collections = { lucide: async () => globalThis.__chronovalIconCollection };',
      },
    }],
  })
  for (const [id, role, mustChangePassword] of [[1, 'admin', false], [2, 'user', false], [3, 'user', true]]) {
    runtime.db.insert(users).values({
      id, username: `icon_user_${id}`, usernameKey: `icon_user_${id}`,
      displayName: 'Icon test', email: `icon${id}@test.invalid`,
      emailKey: `icon${id}@test.invalid`, password: 'hashed:test',
      role, mustChangePassword, createdAt: new Date(),
    }).run()
  }
  // Exercise the installed Nuxt Icon handler behind the real access middleware.
  // Only Nuxt's generated collection registry and cache wrapper are substituted.
  const handler = (await import(iconHandlerURL)).default
  runtime.router.get('/api/_nuxt_icon/:collection', handler)
  runtime.router.head('/api/_nuxt_icon/:collection', handler)
  runtime.router.get('/api/photos', defineEventHandler(() => []))
})

after(async () => {
  await runtime?.close()
  globalThis.$fetch = previousFetch
  delete globalThis.__chronovalIconCollection
})

const request = (route, user = 'guest', options = {}) => fetch(runtime.origin + route, {
  ...options,
  headers: { Cookie: `test_session=${user}`, Origin: runtime.origin, 'x-csrf-token': 'test-csrf-token' },
})

test('local icons work offline for visitors, members, admins and initial-password accounts', async () => {
  for (const user of ['guest', 1, 2, 3]) {
    for (const collection of ['lucide', 'lucide.json']) {
      const response = await request(`/api/_nuxt_icon/${collection}?icons=chevron-down,check,arrow-up-right`, user)
      assert.equal(response.status, 200, await response.clone().text())
      const data = await response.json()
      assert.equal(data.prefix, 'lucide')
      for (const name of ['chevron-down', 'check', 'arrow-up-right']) assert.ok(data.icons[name]?.body, name)
    }
  }
  assert.equal(fallbackRequests, 0)
})

test('HEAD works and missing local collections return 404 without a network fallback', async () => {
  const response = await request('/api/_nuxt_icon/lucide.json?icons=check', 3, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
  assert.equal((await request('/api/_nuxt_icon/unknown-local-collection.json?icons=check')).status, 404)
  assert.equal(fallbackRequests, 0)
})

test('icon exception does not expose writes, other internal APIs or restricted photo APIs', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await request('/api/_nuxt_icon/lucide.json?icons=check', 'guest', { method })).status, 401)
    assert.equal((await request('/api/_nuxt_icon/lucide.json?icons=check', 2, { method })).status, 403)
  }
  for (const route of ['/api/_nuxt_icon/lucide/admin', '/api/_nuxt_other/lucide']) {
    assert.equal((await request(route)).status, 401)
  }
  const restricted = await request('/api/photos', 3)
  assert.equal(restricted.status, 403)
  assert.equal((await restricted.json()).data.code, 'PASSWORD_CHANGE_REQUIRED')
})
