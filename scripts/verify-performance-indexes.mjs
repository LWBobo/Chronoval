import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const tempDir = await mkdtemp(path.join(tmpdir(), 'chronoval-index-test-'))
const dbPath = path.join(tempDir, 'index-test.sqlite3')
const db = new Database(dbPath)

try {
  const migration = await readFile(
    new URL(
      '../server/database/migrations/0000_baseline.sql',
      import.meta.url,
    ),
    'utf8',
  )
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }

  const photoIndexes = new Set(
    db
      .prepare('PRAGMA index_list(photos)')
      .all()
      .map((row) => row.name),
  )
  const queueIndexes = new Set(
    db
      .prepare('PRAGMA index_list(pipeline_queue)')
      .all()
      .map((row) => row.name),
  )

  for (const name of [
    'idx_photos_gallery_order',
    'idx_photos_library_path',
    'idx_photos_mount_path',
    'idx_photos_geo_timeline',
  ]) {
    assert(photoIndexes.has(name), `missing ${name}`)
  }
  for (const name of [
    'idx_pipeline_queue_pending',
    'idx_pipeline_queue_status_completed',
  ]) {
    assert(queueIndexes.has(name), `missing ${name}`)
  }

  const galleryPlan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, date_taken FROM photos
       WHERE deleted_at IS NULL
       ORDER BY date_taken DESC, id ASC
       LIMIT 600`,
    )
    .all()
    .map((row) => row.detail)
    .join(' ')
  assert.match(galleryPlan, /idx_photos_gallery_order/)
  assert.doesNotMatch(galleryPlan, /USE TEMP B-TREE FOR ORDER BY/)

  const mapPlan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, date_taken, latitude, longitude FROM photos
       WHERE deleted_at IS NULL
         AND latitude IS NOT NULL
         AND longitude IS NOT NULL
       ORDER BY date_taken ASC, id ASC`,
    )
    .all()
    .map((row) => row.detail)
    .join(' ')
  assert.match(mapPlan, /idx_photos_geo_timeline/)
  assert.doesNotMatch(mapPlan, /USE TEMP B-TREE FOR ORDER BY/)

  const queuePlan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM pipeline_queue
       WHERE status = 'pending' AND created_at <= ?
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
    )
    .all(Math.floor(Date.now() / 1000))
    .map((row) => row.detail)
    .join(' ')
  assert.match(queuePlan, /idx_pipeline_queue_pending/)

  console.log('baseline performance indexes verified')
} finally {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
}
