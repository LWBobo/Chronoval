import { addProtocol, setMaxParallelImageRequests } from 'maplibre-gl'
import { PMTiles, Protocol } from 'pmtiles'
import { getPmtilesDirectoryCache } from '~/utils/pmtilesDirectoryCache'
import { PersistentRangeSource } from '~/utils/pmtilesPersistentSource'
import {
  mapParallelRequestLimit,
  readTimelineNetworkMode,
  resolveTimelineNetworkMode,
  TIMELINE_NETWORK_CHANGE_EVENT,
  type TimelineNetworkMode,
} from '~/utils/mapNetworkProfile'

/**
 * Register the pmtiles:// protocol on the same maplibre-gl instance the
 * map components use. Must run before the first map is created.
 *
 * A shared directory cache keeps leaf/root indexes warm across hops so
 * timeline follow does not re-read the same PMTiles directories on every tile.
 */
export default defineNuxtPlugin(() => {
  const applyRequestLimit = (selected: TimelineNetworkMode) => {
    setMaxParallelImageRequests(
      mapParallelRequestLimit(resolveTimelineNetworkMode(selected)),
    )
  }
  applyRequestLimit(readTimelineNetworkMode())
  window.addEventListener(TIMELINE_NETWORK_CHANGE_EVENT, (event) => {
    const selected = (event as CustomEvent<TimelineNetworkMode>).detail
    applyRequestLimit(selected || 'auto')
  })

  const directoryCache = getPmtilesDirectoryCache()
  const protocol = new Protocol()

  const ensureInstance = (url: string) => {
    if (protocol.get(url)) return
    protocol.add(new PMTiles(new PersistentRangeSource(url), directoryCache))
  }

  const original = protocol.tile.bind(protocol)
  protocol.tile = (params: { url?: string; type?: string }, ...rest: unknown[]) => {
    const raw = String(params?.url || '')
    if (raw.startsWith('pmtiles://')) {
      if (params.type === 'json') {
        ensureInstance(raw.slice('pmtiles://'.length))
      } else {
        const match = /pmtiles:\/\/(.+)\/\d+\/\d+\/\d+/.exec(raw)
        if (match?.[1]) ensureInstance(match[1])
      }
    }
    return (original as Function)(params, ...rest)
  }

  try {
    addProtocol('pmtiles', protocol.tile)
  } catch {
    // The protocol is already registered after a hot reload.
  }
})
