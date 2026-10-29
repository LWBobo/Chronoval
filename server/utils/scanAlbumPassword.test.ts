import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  hashAlbumPassword,
  verifyAlbumPassword,
} from './scanAlbumPassword.ts'

test('new album passwords use salted scrypt and verify correctly', async () => {
  const first = hashAlbumPassword('correct horse battery staple')
  const second = hashAlbumPassword('correct horse battery staple')
  assert.match(first, /^scrypt-v1\$/)
  assert.notEqual(first, second)
  assert.equal(
    await verifyAlbumPassword(first, 'correct horse battery staple'),
    true,
  )
  assert.equal(await verifyAlbumPassword(first, 'wrong password'), false)
})

test('legacy unsalted sha256 passwords remain readable', async () => {
  const digest = createHash('sha256').update('legacy-pass').digest('hex')
  assert.equal(
    await verifyAlbumPassword(`sha256$${digest}`, 'legacy-pass'),
    true,
  )
})
