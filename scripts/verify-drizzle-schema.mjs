import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../server/database/schema.ts'

const sqlite = new Database(':memory:')
try {
  const db = drizzle(sqlite, { schema })
  assert(db, 'Drizzle schema initialization failed')
  console.log('drizzle schema initialization verified')
} finally {
  sqlite.close()
}
