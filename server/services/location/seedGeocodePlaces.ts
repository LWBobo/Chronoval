import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  statSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import Database from 'better-sqlite3'

const META_VERSION_KEY = 'geocode_places_seed_version'
const META_HASH_KEY = 'geocode_places_seed_hash'
const META_COUNT_KEY = 'geocode_places_seed_count'

type SeedManifest = {
  version: string
  expectedCount: number
  filename: string
}

function seedLogger() {
  return logger.dynamic('geocode-seed')
}

/** 种子 CSV / manifest 候选路径（镜像内优先，开发机回退 data/map_info） */
export function resolveGeocodeSeedPaths(cwd = process.cwd()): {
  manifestPath: string | null
  csvPath: string | null
} {
  const manifestCandidates = [
    resolve(cwd, 'server/assets/geocode/seed.json'),
    resolve(cwd, 'data/map_info/seed.json'),
  ]
  const csvCandidates = [
    resolve(cwd, 'server/assets/geocode/geocode_places.csv'),
    resolve(cwd, 'data/map_info/geocode_places_90000.csv'),
    resolve(cwd, 'data/map_info/geocode_places.csv'),
  ]

  const manifestPath =
    manifestCandidates.find((path) => existsSync(path)) ?? null
  const csvPath = csvCandidates.find((path) => existsSync(path)) ?? null
  return { manifestPath, csvPath }
}

function readManifest(manifestPath: string | null): SeedManifest | null {
  if (!manifestPath) return null
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<SeedManifest>
    if (!raw.version || !raw.expectedCount) return null
    return {
      version: String(raw.version),
      expectedCount: Number(raw.expectedCount),
      filename: String(raw.filename || 'geocode_places.csv'),
    }
  } catch {
    return null
  }
}

function readMeta(sqlite: Database.Database, key: string): string | null {
  const row = sqlite
    .prepare(`SELECT value FROM app_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

function writeMeta(sqlite: Database.Database, key: string, value: string) {
  sqlite
    .prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value)
}

function ensureTable(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS geocode_places (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      name_en TEXT,
      aliases TEXT,
      pinyin TEXT,
      pinyin_abbr TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      country TEXT,
      province TEXT,
      city TEXT,
      district TEXT,
      place_type TEXT,
      admin_code TEXT,
      priority INTEGER DEFAULT 0 NOT NULL,
      enabled INTEGER DEFAULT 1 NOT NULL,
      source TEXT,
      notes TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_geocode_places_enabled_priority
      ON geocode_places (enabled, priority);
    CREATE INDEX IF NOT EXISTS idx_geocode_places_name ON geocode_places (name);
    CREATE INDEX IF NOT EXISTS idx_geocode_places_city ON geocode_places (city);
    CREATE INDEX IF NOT EXISTS idx_geocode_places_province ON geocode_places (province);
    CREATE INDEX IF NOT EXISTS idx_geocode_places_district ON geocode_places (district);
    CREATE INDEX IF NOT EXISTS idx_geocode_places_place_type ON geocode_places (place_type);
  `)
}

function countPlaces(sqlite: Database.Database): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM geocode_places`)
    .get() as { c: number }
  return Number(row?.c || 0)
}

/** 快速指纹：尺寸 + 头/尾各 256KB，避免每次启动全量读入 32MB */
function fingerprintSeedFile(csvPath: string): string {
  const st = statSync(csvPath)
  const sample = 256 * 1024
  const fd = openSync(csvPath, 'r')
  try {
    const head = Buffer.alloc(Math.min(sample, st.size))
    readSync(fd, head, 0, head.length, 0)
    const tailLen = st.size > sample ? Math.min(sample, st.size - sample) : 0
    const tail = Buffer.alloc(tailLen)
    if (tailLen > 0) {
      readSync(fd, tail, 0, tailLen, st.size - tailLen)
    }
    return `${st.size}:${createHash('sha256')
      .update(String(st.size))
      .update(head)
      .update(tail)
      .digest('hex')
      .slice(0, 24)}`
  } finally {
    closeSync(fd)
  }
}

function emptyToNull(value: string | undefined): string | null {
  const text = (value || '').trim()
  return text ? text : null
}

function parseEnabled(value: string | undefined): number {
  const text = (value || '1').trim()
  return text === '0' || text.toLowerCase() === 'false' ? 0 : 1
}

async function importCsv(
  sqlite: Database.Database,
  csvPath: string,
): Promise<number> {
  const insert = sqlite.prepare(`
    INSERT INTO geocode_places (
      name, name_en, aliases, pinyin, pinyin_abbr,
      latitude, longitude, country, province, city, district,
      place_type, admin_code, priority, enabled, source, notes,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      unixepoch(), unixepoch()
    )
  `)

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let headers: string[] | null = null
  let imported = 0
  const batch: unknown[][] = []
  const flush = sqlite.transaction((rows: unknown[][]) => {
    for (const row of rows) insert.run(...row)
  })

  for await (const line of rl) {
    const trimmed = line.replace(/^\uFEFF/, '')
    if (!trimmed) continue
    const cols = parseCsvLine(trimmed)
    if (!headers) {
      headers = cols.map((c) => c.trim())
      continue
    }
    const row: Record<string, string> = {}
    headers.forEach((key, i) => {
      row[key] = cols[i] ?? ''
    })

    const name = emptyToNull(row.name)
    if (!name) continue
    const lat = Number(row.latitude)
    const lon = Number(row.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue

    const priorityRaw = emptyToNull(row.priority)
    const priority = priorityRaw ? Number.parseInt(priorityRaw, 10) || 0 : 0

    batch.push([
      name,
      emptyToNull(row.name_en),
      emptyToNull(row.aliases),
      emptyToNull(row.pinyin),
      emptyToNull(row.pinyin_abbr),
      lat,
      lon,
      emptyToNull(row.country),
      emptyToNull(row.province),
      emptyToNull(row.city),
      emptyToNull(row.district),
      emptyToNull(row.place_type),
      emptyToNull(row.admin_code),
      priority,
      parseEnabled(row.enabled),
      emptyToNull(row.source),
      emptyToNull(row.notes),
    ])

    if (batch.length >= 1000) {
      flush(batch)
      imported += batch.length
      batch.length = 0
    }
  }

  if (batch.length) {
    flush(batch)
    imported += batch.length
  }

  return imported
}

/** 简易 CSV 行解析（支持双引号字段） */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

/**
 * 启动时确保本地地名库就绪：
 * - 表不存在 → 建表
 * - 无数据 / 行数明显不足 / 种子版本或文件指纹变化 → 清空并重新导入镜像内 CSV
 *
 * 幂等：种子未变且行数达标时直接跳过。
 */
export async function ensureGeocodePlacesSeeded(
  dbPath: string,
  cwd = process.cwd(),
): Promise<void> {
  const log = seedLogger()
  const { manifestPath, csvPath } = resolveGeocodeSeedPaths(cwd)
  const manifest = readManifest(manifestPath)

  if (!csvPath) {
    log.warn(
      '未找到地名种子 CSV（server/assets/geocode/geocode_places.csv），跳过导入',
    )
    return
  }

  const sqlite = new Database(dbPath)
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS app_meta (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
       )`,
    )
    ensureTable(sqlite)

    const expected = manifest?.expectedCount ?? 0
    const seedVersion = manifest?.version ?? 'file-only'
    const fp = fingerprintSeedFile(csvPath)
    const count = countPlaces(sqlite)
    const metaVersion = readMeta(sqlite, META_VERSION_KEY)
    const metaHash = readMeta(sqlite, META_HASH_KEY)

    const incomplete =
      count <= 0 || (expected > 0 && count < Math.floor(expected * 0.95))
    const versionChanged = metaVersion !== seedVersion || metaHash !== fp

    if (!incomplete && !versionChanged) {
      log.info(
        `地名库已就绪：${count} 条（seed=${seedVersion}），跳过导入`,
      )
      return
    }

    log.info(
      `开始导入地名种子：csv=${csvPath} version=${seedVersion} ` +
        `dbCount=${count} expected=${expected || '?'} reason=${
          incomplete ? 'incomplete' : 'seed-changed'
        }`,
    )

    const tx = sqlite.transaction(() => {
      sqlite.exec(`DELETE FROM geocode_places`)
    })
    tx()

    const imported = await importCsv(sqlite, csvPath)
    writeMeta(sqlite, META_VERSION_KEY, seedVersion)
    writeMeta(sqlite, META_HASH_KEY, fp)
    writeMeta(sqlite, META_COUNT_KEY, String(imported))

    if (expected > 0 && imported < Math.floor(expected * 0.95)) {
      throw new Error(
        `地名种子导入不完整：imported=${imported} expected=${expected}`,
      )
    }

    log.success(`地名种子导入完成：${imported} 条（seed=${seedVersion}）`)
  } finally {
    sqlite.close()
  }
}
