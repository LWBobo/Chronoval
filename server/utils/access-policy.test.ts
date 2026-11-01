import assert from 'node:assert/strict'
import test from 'node:test'
import { isPublicIconRequest, resolveApiAccess } from './access-policy.ts'

test('installed icon collections are public for GET and HEAD only', () => {
  for (const method of ['GET', 'HEAD', 'get']) {
    for (const path of ['/api/_nuxt_icon/lucide', '/api/_nuxt_icon/lucide.json', '/api/_nuxt_icon/fluent-emoji-flat.json/']) {
      assert.equal(isPublicIconRequest(method, path), true, `${method} ${path}`)
      assert.equal(resolveApiAccess(method, path), 'public', `${method} ${path}`)
    }
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(isPublicIconRequest(method, '/api/_nuxt_icon/lucide.json'), false)
    assert.equal(resolveApiAccess(method, '/api/_nuxt_icon/lucide.json'), 'admin')
  }
  for (const path of ['/api/_nuxt_icon', '/api/_nuxt_icon/', '/api/_nuxt_icon/lucide/admin', '/api/_nuxt_icon/../users', '/api/_nuxt_icon/lucide.json.js', '/api/_nuxt_icon/-lucide', '/api/_nuxt_other/lucide']) {
    assert.equal(isPublicIconRequest('GET', path), false, path)
    assert.equal(resolveApiAccess('GET', path), 'admin', path)
  }
})

test('public read routes remain public', () => {
  const routes = [
    ['GET', '/api/photos'],
    ['GET', '/api/photos/visible'],
    ['GET', '/api/photos/feed-status'],
    ['GET', '/api/albums'],
    ['GET', '/api/albums/42'],
    ['GET', '/api/people'],
    ['GET', '/api/people/person-1'],
    ['POST', '/api/search/smart'],
    ['GET', '/api/system/settings/all'],
    ['GET', '/api/map/photos'],
    ['GET', '/api/map/photos/photo-1/thumbnail'],
    ['POST', '/api/map/cache/touch'],
  ] as const

  for (const [method, path] of routes) {
    assert.equal(resolveApiAccess(method, path), 'public', `${method} ${path}`)
  }
})

test('method restrictions do not accidentally expose writes', () => {
  assert.equal(resolveApiAccess('POST', '/api/photos'), 'admin')
  assert.equal(resolveApiAccess('DELETE', '/api/albums/42'), 'admin')
  assert.equal(resolveApiAccess('POST', '/api/people'), 'admin')
  assert.equal(
    resolveApiAccess('POST', '/api/map/photos/photo-1/thumbnail'),
    'admin',
  )
  assert.equal(resolveApiAccess('PUT', '/api/system/settings/all'), 'admin')
})

test('authenticated routes and default-deny behavior are preserved', () => {
  assert.equal(resolveApiAccess('GET', '/api/profile'), 'user')
  assert.equal(resolveApiAccess('GET', '/api/auth/login-logs'), 'user')
  assert.equal(resolveApiAccess('GET', '/api/photos/p1/livephoto'), 'public')
  assert.equal(resolveApiAccess('GET', '/api/unknown/new-route'), 'admin')
  assert.equal(resolveApiAccess('POST', '/api/queue/add-task'), 'admin')
})

test('session self-service stays usable without granting administrative APIs', () => {
  assert.equal(resolveApiAccess('GET', '/api/_auth/session'), 'public')
  assert.equal(resolveApiAccess('DELETE', '/api/_auth/session'), 'public')
  assert.equal(resolveApiAccess('POST', '/api/_auth/session'), 'admin')
  assert.equal(resolveApiAccess('PUT', '/api/photos/p1/reactions'), 'admin')
  assert.equal(resolveApiAccess('HEAD', '/api/photos/'), 'public')
  assert.equal(resolveApiAccess('GET', '/api/users/'), 'admin')
})
