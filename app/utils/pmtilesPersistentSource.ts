import {
  FetchSource,
  type RangeResponse,
  type Source,
} from 'pmtiles'

const CACHE_NAME = 'chronoval-pmtiles-ranges-v1'
const MANIFEST_KEY = 'chronoval:pmtiles-range-cache-v1'
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_CACHE_ENTRIES = 1800
const MAX_RANGE_BYTES = 2 * 1024 * 1024

type CacheEntry = { key: string; size: number; lastUsed: number }
type CacheManifest = { entries: Record<string, CacheEntry> }

let maintenance = Promise.resolve()
const pendingManifestUpdates = new Map<string, number>()
let manifestFlushTimer: ReturnType<typeof setTimeout> | null = null

function sourceHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function cacheRequest(
  sourceUrl: string,
  offset: number,
  length: number,
  etag?: string,
): Request {
  const key = new URL('/__chronoval_pmtiles_cache__/range', location.origin)
  key.searchParams.set('archive', sourceHash(sourceUrl))
  key.searchParams.set('offset', String(offset))
  key.searchParams.set('length', String(length))
  key.searchParams.set('etag', etag || 'none')
  return new Request(key, { method: 'GET', credentials: 'same-origin' })
}

function readManifest(): CacheManifest {
  try {
    const parsed = JSON.parse(localStorage.getItem(MANIFEST_KEY) || '')
    if (parsed?.entries && typeof parsed.entries === 'object') return parsed
  } catch {
    // Recreate invalid or unavailable metadata.
  }
  return { entries: {} }
}

function queueManifestUpdate(key: string, size: number) {
  pendingManifestUpdates.set(key, size)
  if (manifestFlushTimer) return
  manifestFlushTimer = setTimeout(() => {
    manifestFlushTimer = null
    const updates = [...pendingManifestUpdates.entries()]
    pendingManifestUpdates.clear()
    maintenance = maintenance
      .then(async () => {
        const manifest = readManifest()
        const now = Date.now()
        for (const [entryKey, entrySize] of updates) {
          manifest.entries[entryKey] = {
            key: entryKey,
            size: entrySize,
            lastUsed: now,
          }
        }
        let entries = Object.values(manifest.entries)
        let total = entries.reduce((sum, entry) => sum + entry.size, 0)

        if (total > MAX_CACHE_BYTES || entries.length > MAX_CACHE_ENTRIES) {
          const cache = await caches.open(CACHE_NAME)
          entries = entries.sort((a, b) => a.lastUsed - b.lastUsed)
          while (
            entries.length > 0 &&
            (total > MAX_CACHE_BYTES || entries.length > MAX_CACHE_ENTRIES)
          ) {
            const oldest = entries.shift()!
            total -= oldest.size
            delete manifest.entries[oldest.key]
            await cache.delete(oldest.key)
          }
        }

        localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest))
      })
      .catch(() => {
        // Cache Storage and localStorage are optional performance layers.
      })
  }, 1200)
}

/**
 * PMTiles Source backed by Cache Storage. Chromium intentionally disables its
 * normal HTTP cache for Range requests on Windows, so a synthetic per-range
 * cache key avoids downloading the same vector tiles again on later visits.
 */
export class PersistentRangeSource implements Source {
  private readonly fallback: FetchSource

  constructor(private readonly url: string) {
    this.fallback = new FetchSource(url, new Headers(), 'same-origin')
  }

  getKey() {
    return this.url
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    signal?.throwIfAborted()
    const canPersist =
      typeof caches !== 'undefined' &&
      typeof localStorage !== 'undefined' &&
      length <= MAX_RANGE_BYTES
    const request = canPersist
      ? cacheRequest(this.url, offset, length, etag)
      : null

    if (request) {
      try {
        const cache = await caches.open(CACHE_NAME)
        const cached = await cache.match(request)
        if (cached) {
          const data = await cached.arrayBuffer()
          signal?.throwIfAborted()
          queueManifestUpdate(request.url, data.byteLength)
          return {
            data,
            etag: cached.headers.get('x-pmtiles-etag') || undefined,
            cacheControl:
              cached.headers.get('x-pmtiles-cache-control') || undefined,
            expires: cached.headers.get('x-pmtiles-expires') || undefined,
          }
        }
      } catch {
        // Fall back to the network when Cache Storage is unavailable.
      }
    }

    const response = await this.fallback.getBytes(offset, length, signal, etag)
    signal?.throwIfAborted()

    if (request && response.data.byteLength <= MAX_RANGE_BYTES) {
      const headers = new Headers({ 'content-type': 'application/octet-stream' })
      if (response.etag) headers.set('x-pmtiles-etag', response.etag)
      if (response.cacheControl)
        headers.set('x-pmtiles-cache-control', response.cacheControl)
      if (response.expires)
        headers.set('x-pmtiles-expires', response.expires)
      void caches
        .open(CACHE_NAME)
        .then((cache) =>
          cache.put(request, new Response(response.data.slice(0), { headers })),
        )
        .then(() => queueManifestUpdate(request.url, response.data.byteLength))
        .catch(() => undefined)
    }

    return response
  }
}
