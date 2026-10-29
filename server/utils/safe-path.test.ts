import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { isPathInsideRoot } from './safe-path.ts'

const root = path.resolve('sandbox', 'storage')

test('accepts normal nested media keys', () => {
  assert.equal(isPathInsideRoot(root, 'photos/2026/a.jpg'), true)
  assert.equal(isPathInsideRoot(root, 'thumbnails/a.webp'), true)
})

test('rejects parent traversal with slash or encoded backslash', () => {
  assert.equal(isPathInsideRoot(root, '../data/app.db'), false)
  assert.equal(isPathInsideRoot(root, '..\\data\\app.db'), false)
  assert.equal(
    isPathInsideRoot(root, decodeURIComponent('%2e%2e%5cdata%5capp.db')),
    false,
  )
})

test('rejects the storage root itself', () => {
  assert.equal(isPathInsideRoot(root, ''), false)
  assert.equal(isPathInsideRoot(root, '.'), false)
})
