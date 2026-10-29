import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open as openFd,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

const MEM_MB = Math.max(
  0,
  Number(process.env.CHRONOVAL_PMTILES_CACHE_MEM_MB ?? 256) || 256,
)
const DISK_MB = Math.max(
  0,
  Number(process.env.CHRONOVAL_PMTILES_CACHE_DISK_MB ?? 2048) || 0,
)
const IDLE_MS = Math.max(
  30_000,
  Number(process.env.CHRONOVAL_PMTILES_CACHE_IDLE_MS ?? 600_000) || 600_000,
)
/** Only cache reasonably sized Range slices in MEM/DISK. */
export const PMTILES_CACHEABLE_SLICE_BYTES = 2 * 1024 * 1024

const CACHE_DIR = join(process.cwd(), 'data', 'pmtiles-range-cache')
const INDEX_FILE = join(CACHE_DIR, 'index.json')
const MEM_BUDGET = MEM_MB * 1024 * 1024
const DISK_BUDGET = DISK_MB * 1024 * 1024

type MemEntry = {
  key: string
  buf: Buffer
  bytes: number
  lastUsed: number
}

type DiskIndexEntry = {
  key: string
  file: string
  bytes: number
  lastUsed: number
}

const mem = new Map<string, MemEntry>()
let memBytes = 0
const diskIndex = new Map<string, DiskIndexEntry>()
let diskBytes = 0
const inflight = new Map<
  string,
  Promise<{ body: Buffer; cache: 'DISK' | 'MISS' }>
>()
const archiveVersions = new Map<string, string>()
let lastAccessAt = 0
let reaperStarted = false
let diskReady: Promise<void> | null = null
let releasing = false
let manifestTimer: ReturnType<typeof setTimeout> | null = null

function cacheKey(
  fileName: string,
  mtimeMs: number,
  size: number,
  start: number,
  end: number,
) {
  return `${fileName}|${mtimeMs}|${size}|${start}-${end}`
}

async function ensureArchiveVersion(
  fileName: string,
  mtimeMs: number,
  size: number,
) {
  const version = `${fileName}|${mtimeMs}|${size}|`
  if (archiveVersions.get(fileName) === version) return
  archiveVersions.set(fileName, version)

  for (const [key, entry] of mem) {
    if (key.startsWith(`${fileName}|`) && !key.startsWith(version)) {
      mem.delete(key)
      memBytes -= entry.bytes
    }
  }
  if (DISK_BUDGET <= 0) return
  await ensureDiskDir()
  for (const [key, entry] of diskIndex) {
    if (!key.startsWith(`${fileName}|`) || key.startsWith(version)) continue
    diskIndex.delete(key)
    diskBytes -= entry.bytes
    void unlink(join(CACHE_DIR, entry.file)).catch(() => {})
  }
  scheduleManifestWrite()
}

function diskFileName(key: string) {
  return createHash('sha1').update(key).digest('hex') + '.bin'
}

function touchActivity() {
  lastAccessAt = Date.now()
}

export function touchPmtilesCacheActivity() {
  touchActivity()
  ensureReaper()
}

async function ensureDiskDir() {
  if (DISK_BUDGET <= 0) return
  if (!diskReady) {
    diskReady = mkdir(CACHE_DIR, { recursive: true }).then(async () => {
      try {
        const parsed = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as {
          entries?: DiskIndexEntry[]
        }
        for (const entry of parsed.entries ?? []) {
          if (
            !entry?.key ||
            !entry.file?.endsWith('.bin') ||
            !Number.isFinite(entry.bytes) ||
            entry.bytes <= 0
          )
            continue
          diskIndex.set(entry.key, entry)
          diskBytes += entry.bytes
        }
      } catch {
        // Missing/old caches are discovered lazily by their deterministic key.
      }
    })
  }
  await diskReady
}

async function writeManifest() {
  if (DISK_BUDGET <= 0 || releasing) return
  await mkdir(CACHE_DIR, { recursive: true })
  const temp = `${INDEX_FILE}.tmp`
  await writeFile(
    temp,
    JSON.stringify({ version: 1, entries: [...diskIndex.values()] }),
  )
  await rename(temp, INDEX_FILE)
}

function scheduleManifestWrite() {
  if (manifestTimer || DISK_BUDGET <= 0 || releasing) return
  manifestTimer = setTimeout(() => {
    manifestTimer = null
    void writeManifest().catch((error) =>
      console.warn('[pmtiles-range-cache] manifest write failed', error),
    )
  }, 250)
  manifestTimer.unref?.()
}

function evictMem(needed: number) {
  if (MEM_BUDGET <= 0) return
  while (memBytes + needed > MEM_BUDGET && mem.size > 0) {
    let oldest: MemEntry | null = null
    for (const entry of mem.values()) {
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry
    }
    if (!oldest) break
    mem.delete(oldest.key)
    memBytes -= oldest.bytes
  }
}

async function evictDisk(needed: number) {
  if (DISK_BUDGET <= 0) return
  while (diskBytes + needed > DISK_BUDGET && diskIndex.size > 0) {
    let oldest: DiskIndexEntry | null = null
    for (const entry of diskIndex.values()) {
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry
    }
    if (!oldest) break
    diskIndex.delete(oldest.key)
    diskBytes -= oldest.bytes
    try {
      await unlink(join(CACHE_DIR, oldest.file))
    } catch {
      // already gone
    }
    scheduleManifestWrite()
  }
}

function putMem(key: string, buf: Buffer) {
  if (MEM_BUDGET <= 0 || buf.length > PMTILES_CACHEABLE_SLICE_BYTES) return
  if (buf.length > MEM_BUDGET) return
  evictMem(buf.length)
  const existing = mem.get(key)
  if (existing) {
    memBytes -= existing.bytes
  }
  mem.set(key, {
    key,
    buf,
    bytes: buf.length,
    lastUsed: Date.now(),
  })
  memBytes += buf.length
}

async function putDisk(key: string, buf: Buffer) {
  if (DISK_BUDGET <= 0 || buf.length > PMTILES_CACHEABLE_SLICE_BYTES) return
  if (buf.length > DISK_BUDGET) return
  await ensureDiskDir()
  await evictDisk(buf.length)
  const file = diskFileName(key)
  const full = join(CACHE_DIR, file)
  try {
    await writeFile(full, buf)
  } catch (error) {
    console.warn('[pmtiles-range-cache] disk write failed', error)
    return
  }
  const existing = diskIndex.get(key)
  if (existing) {
    diskBytes -= existing.bytes
    if (existing.file !== file) {
      try {
        await unlink(join(CACHE_DIR, existing.file))
      } catch {
        // ignore
      }
    }
  }
  diskIndex.set(key, {
    key,
    file,
    bytes: buf.length,
    lastUsed: Date.now(),
  })
  diskBytes += buf.length
  scheduleManifestWrite()
}

async function getDisk(key: string): Promise<Buffer | null> {
  if (DISK_BUDGET <= 0) return null
  await ensureDiskDir()
  let entry = diskIndex.get(key)
  const file = entry?.file ?? diskFileName(key)
  const full = join(CACHE_DIR, file)
  try {
    const buf = await readFile(full)
    const now = Date.now()
    if (!entry) {
      entry = { key, file, bytes: buf.length, lastUsed: now }
      diskIndex.set(key, entry)
      diskBytes += buf.length
    } else {
      entry.lastUsed = now
    }
    scheduleManifestWrite()
    return buf
  } catch {
    if (entry) {
      diskIndex.delete(key)
      diskBytes -= entry.bytes
      scheduleManifestWrite()
    }
    return null
  }
}

async function readRangeFromFile(
  filePath: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const length = end - start + 1
  const buf = Buffer.allocUnsafe(length)
  const handle = await openFd(filePath, 'r')
  try {
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buf,
        offset,
        length - offset,
        start + offset,
      )
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    if (offset !== length) {
      return buf.subarray(0, offset)
    }
    return buf
  } finally {
    await handle.close()
  }
}

/**
 * Fetch a byte range through MEM → DISK → file, with singleflight.
 * Returns null when the slice is too large to cache (caller should stream).
 */
export async function resolvePmtilesRange(options: {
  fileName: string
  filePath: string
  mtimeMs: number
  size: number
  start: number
  end: number
}): Promise<{ body: Buffer; cache: 'MEM' | 'DISK' | 'MISS' } | null> {
  touchActivity()
  ensureReaper()

  const length = options.end - options.start + 1
  if (length <= 0) return null
  if (length > PMTILES_CACHEABLE_SLICE_BYTES) {
    return null
  }

  await ensureArchiveVersion(options.fileName, options.mtimeMs, options.size)

  const key = cacheKey(
    options.fileName,
    options.mtimeMs,
    options.size,
    options.start,
    options.end,
  )

  const memHit = mem.get(key)
  if (memHit) {
    memHit.lastUsed = Date.now()
    return { body: memHit.buf, cache: 'MEM' }
  }

  const existing = inflight.get(key)
  if (existing) {
    const shared = await existing
    return {
      body: shared.body,
      cache: shared.cache === 'MISS' ? 'MISS' : 'DISK',
    }
  }

  const load = (async (): Promise<{ body: Buffer; cache: 'DISK' | 'MISS' }> => {
    if (!releasing) {
      const fromDisk = await getDisk(key)
      if (fromDisk) {
        putMem(key, fromDisk)
        return { body: fromDisk, cache: 'DISK' }
      }
    }
    const fromFile = await readRangeFromFile(
      options.filePath,
      options.start,
      options.end,
    )
    putMem(key, fromFile)
    void putDisk(key, fromFile)
    return { body: fromFile, cache: 'MISS' }
  })()

  inflight.set(key, load)
  try {
    return await load
  } finally {
    inflight.delete(key)
  }
}

export async function clearPmtilesRangeCache() {
  releasing = true
  try {
    if (manifestTimer) clearTimeout(manifestTimer)
    manifestTimer = null
    mem.clear()
    memBytes = 0
    for (const entry of diskIndex.values()) {
      try {
        await unlink(join(CACHE_DIR, entry.file))
      } catch {
        // ignore
      }
    }
    diskIndex.clear()
    diskBytes = 0
    archiveVersions.clear()
    try {
      await rm(CACHE_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
    diskReady = null
  } finally {
    releasing = false
  }
}

async function maybeReapIdle() {
  if (!lastAccessAt) return
  if (Date.now() - lastAccessAt < IDLE_MS) return
  if (mem.size === 0) return
  console.info(
    `[pmtiles-range-cache] idle ≥ ${IDLE_MS}ms; clearing MEM (${memBytes}B), keeping DISK (${diskBytes}B)`,
  )
  mem.clear()
  memBytes = 0
}

function ensureReaper() {
  if (reaperStarted) return
  reaperStarted = true
  const interval = setInterval(() => {
    void maybeReapIdle()
  }, 30_000)
  interval.unref?.()
}

/**
 * Opportunistically warm the PMTiles header (first 16 KiB).
 * Safe, tiny, and used on almost every map open.
 */
export async function warmPmtilesHeader(options: {
  fileName: string
  filePath: string
  mtimeMs: number
  size: number
}) {
  touchActivity()
  ensureReaper()
  const end = Math.min(16 * 1024 - 1, options.size - 1)
  if (end < 0) return
  try {
    await resolvePmtilesRange({
      ...options,
      start: 0,
      end,
    })
  } catch (error) {
    console.warn('[pmtiles-range-cache] header warm failed', error)
  }
}

/** Stream a non-cached (large) range from disk. */
export function streamPmtilesRange(
  filePath: string,
  start: number,
  end: number,
) {
  return createReadStream(filePath, { start, end })
}

export function pmtilesCacheStats() {
  return {
    memBytes,
    diskBytes,
    memEntries: mem.size,
    diskEntries: diskIndex.size,
    lastAccessAt,
    memBudget: MEM_BUDGET,
    diskBudget: DISK_BUDGET,
    idleMs: IDLE_MS,
  }
}
