import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { ensureGeocodePlacesSeeded } from '../services/location/seedGeocodePlaces'

let migrationPromise: Promise<void> | null = null
const migrationLogger = logger.dynamic('db-migrate')

async function runMigrations() {
  const dbPath = resolve(process.env.DATABASE_URL || './data/app.sqlite3')

  mkdirSync(dirname(dbPath), { recursive: true })

  // 全新数据库只执行单一基线，不再承担旧结构数据回填。
  const sqlite = new Database(dbPath)
  try {
    const db = drizzle(sqlite)
    await migrate(db, {
      migrationsFolder: resolve('./server/database/migrations'),
    })
    migrationLogger.info('Database schema migration finished successfully')
  } finally {
    sqlite.close()
  }

  // 地名种子独立于业务数据；空库首次启动会自动导入约 9 万条地点。
  await ensureGeocodePlacesSeeded(dbPath)
}

/** 供其它启动插件等待。Nitro 不会 await 插件，队列不能在迁移结束前查表。 */
export function whenDatabaseReady(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runMigrations().catch((error) => {
      migrationLogger.error('Database migration failed', error)
      throw error
    })
  }
  return migrationPromise
}

export default defineNitroPlugin(async () => {
  await whenDatabaseReady()
})
