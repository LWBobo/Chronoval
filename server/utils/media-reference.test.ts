import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { sql } from 'drizzle-orm'
import { SQLiteSyncDialect, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { libraryMediaPath, mediaUrlPathMatches } from './media-reference.ts'

const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  url: text('url'),
})
const dialect = new SQLiteSyncDialect()

function matchingIds(urls: (string | null)[], pathname: string) {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE media (id TEXT PRIMARY KEY, url TEXT)')
    const insert = db.prepare('INSERT INTO media VALUES (?, ?)')
    urls.forEach((url, index) => insert.run(String(index), url))
    const query = dialect.sqlToQuery(sql`
      SELECT ${media.id} FROM ${media}
      WHERE ${mediaUrlPathMatches(media.url, pathname)}
      ORDER BY ${media.id}
    `)
    return db
      .prepare(query.sql)
      .all(...(query.params as string[]))
      .map((row) => row.id)
  } finally {
    db.close()
  }
}

test('library authorization reconstructs the exact URL written by the scanner', () => {
  for (const relative of [
    'plain/IMG_0001.jpeg',
    '20261004北海/IMG_0001.jpeg',
    '旅行 照片/合影 #1?.jpg',
    '100%/literal%20name_01.jpg',
    'emoji/🌊+海边.jpg',
    '实况/合影.MOV',
  ]) {
    const stored = `/library/scan_1/${encodeURIComponent(relative).replace(/%2F/g, '/')}`
    const pathname = libraryMediaPath('scan_1', relative)
    assert.equal(pathname, stored)
    assert.deepEqual(matchingIds([stored], pathname), ['0'], relative)
  }
})

test('URL matching allows query parameters but rejects unrelated paths', () => {
  const pathname = libraryMediaPath('scan_1', '北海/合影_01.jpg')
  assert.deepEqual(
    matchingIds(
      [
        pathname,
        `${pathname}?original=1`,
        `${pathname}?download=1&size=full`,
        `${pathname}.backup`,
        `${pathname}/other.jpg`,
        '/storage/unrelated.jpg',
        null,
      ],
      pathname,
    ),
    ['0', '1', '2'],
  )
})

test('percent escapes and underscores are literal in authorization lookups', () => {
  const pathname = '/library/scan_1/a%20b_1.jpg'
  assert.deepEqual(
    matchingIds(
      [
        pathname,
        `${pathname}?original=1`,
        '/library/scanX1/aOTHER20bX1.jpg?original=1',
        '/library/scan_1/a%20b_1.JPG?original=1',
      ],
      pathname,
    ),
    ['0', '1'],
  )
})

test('stored percent signs are encoded once and distinct from encoded spaces', () => {
  const percent = libraryMediaPath('scan_1', 'photos/a%20b.jpg')
  const space = libraryMediaPath('scan_1', 'photos/a b.jpg')
  assert.notEqual(percent, space)
  assert.deepEqual(matchingIds([percent, space], percent), ['0'])
})
