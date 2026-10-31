import assert from 'node:assert/strict'
import test from 'node:test'
import {
  alignSessionSetCookie,
  alignSessionSetCookies,
} from './session-cookie.ts'

const CLEAR_OVER_HTTP =
  'nuxt-session=; Path=/; HttpOnly; Secure; SameSite=Lax'

test('HTTP 登出会去掉 Secure，并用 Max-Age=0 删掉已有会话', () => {
  assert.equal(
    alignSessionSetCookie(CLEAR_OVER_HTTP, 'nuxt-session', false),
    'nuxt-session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
  )
})

test('HTTPS 登出保留 Secure，同样过期旧 Cookie', () => {
  assert.equal(
    alignSessionSetCookie(CLEAR_OVER_HTTP, 'nuxt-session', true),
    'nuxt-session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
  )
})

test('已按协议写好的登录 Cookie 保持不变', () => {
  const login =
    'nuxt-session=sealed-token; Path=/; HttpOnly; SameSite=Lax'
  assert.equal(alignSessionSetCookie(login, 'nuxt-session', false), login)
})

test('HTTP 下误带 Secure 的登录 Cookie 会被改成浏览器能收下的形式', () => {
  assert.equal(
    alignSessionSetCookie(
      'nuxt-session=sealed-token; Path=/; HttpOnly; Secure; SameSite=Lax',
      'nuxt-session',
      false,
    ),
    'nuxt-session=sealed-token; Path=/; HttpOnly; SameSite=Lax',
  )
})

test('其他 Cookie 原样保留', () => {
  const header = [
    'theme=dark; Path=/',
    'nuxt-session=; Path=/; HttpOnly; Secure',
  ]
  assert.deepEqual(alignSessionSetCookies(header, 'nuxt-session', false), [
    'theme=dark; Path=/',
    'nuxt-session=; Max-Age=0; Path=/; HttpOnly',
  ])
})
