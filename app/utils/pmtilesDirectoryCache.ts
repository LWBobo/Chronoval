import { SharedPromiseCache } from 'pmtiles'

/**
 * One directory cache for every PMTiles instance in the browser so timeline
 * prefetch and MapLibre's protocol share leaf/root index hits.
 */
let cache: SharedPromiseCache | null = null

export function getPmtilesDirectoryCache(): SharedPromiseCache {
  if (!cache) cache = new SharedPromiseCache(512)
  return cache
}
