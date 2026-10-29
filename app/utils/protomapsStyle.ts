import {
  language_script_pairs,
  layers,
  namedFlavor,
} from '@protomaps/basemaps'
import type { StyleSpecification } from 'maplibre-gl'

const SUPPORTED_LANGS = new Set(language_script_pairs.map((pair) => pair.lang))

/** Map a Chronoval locale onto a Protomaps label language. */
export function protomapsLang(locale: string): string {
  if (
    locale === 'zh-Hant-TW' ||
    locale === 'zh-Hant-HK' ||
    locale.startsWith('zh-Hant')
  ) {
    return 'zh-Hant'
  }
  if (locale.startsWith('zh')) return 'zh-Hans'
  if (SUPPORTED_LANGS.has(locale)) return locale
  const short = locale.split('-')[0] || 'en'
  if (SUPPORTED_LANGS.has(short)) return short
  return 'en'
}

export function protomapsStyle(options: {
  dark: boolean
  lang: string
  tileUrl: string
  /**
   * Origin for vendored fonts/sprites under public/map/basemaps-assets.
   * Defaults to same-origin relative paths (works offline / intranet).
   */
  assetBase?: string
}): StyleSpecification {
  const flavor = options.dark ? 'dark' : 'light'
  const assetBase = (options.assetBase || '').replace(/\/$/, '')
  const glyphs = `${assetBase}/map/basemaps-assets/fonts/{fontstack}/{range}.pbf`
  const sprite = `${assetBase}/map/basemaps-assets/sprites/v4/${flavor}`
  return {
    version: 8,
    glyphs,
    sprite,
    sources: {
      protomaps: {
        type: 'vector',
        url: options.tileUrl,
        attribution:
          '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: layers('protomaps', namedFlavor(flavor), {
      lang: options.lang,
    }) as StyleSpecification['layers'],
  }
}

/**
 * Secondary Protomaps layers to hide during timeline follow flight.
 * Prefer visibility over setStyle so tiles stay warm and the map does not flash.
 */
const FOLLOW_MODE_HIDDEN_LAYERS = [
  'pois',
  'address_label',
  'roads_oneway',
  'roads_labels_minor',
  'roads_shields',
  'roads_rail',
  'roads_pier',
  'roads_minor_service',
  'roads_minor_service_casing',
  'roads_link',
  'roads_link_casing',
  'roads_other',
  'roads_tunnels_other_casing',
  'roads_tunnels_minor_casing',
  'roads_tunnels_link_casing',
  'roads_tunnels_major_casing',
  'roads_tunnels_highway_casing',
  'roads_tunnels_other',
  'roads_tunnels_minor',
  'roads_tunnels_link',
  'roads_tunnels_major',
  'roads_tunnels_highway',
  'roads_bridges_other_casing',
  'roads_bridges_link_casing',
  'roads_bridges_minor_casing',
  'roads_bridges_other',
  'roads_bridges_minor',
  'roads_bridges_link',
  'landuse_hospital',
  'landuse_industrial',
  'landuse_school',
  'landuse_beach',
  'landuse_zoo',
  'landuse_aerodrome',
  'landuse_pedestrian',
  'landuse_pier',
  'landuse_runway',
  'roads_runway',
  'roads_taxiway',
  'water_stream',
  'water_waterway_label',
  'places_subplace',
] as const

/**
 * Toggle a lighter basemap while the timeline camera is following places.
 * Restores prior visibility when turned off.
 */
export function setProtomapsFollowMode(map: any, enabled: boolean) {
  if (!map?.getLayer || !map?.setLayoutProperty) return
  for (const id of FOLLOW_MODE_HIDDEN_LAYERS) {
    if (!map.getLayer(id)) continue
    try {
      map.setLayoutProperty(id, 'visibility', enabled ? 'none' : 'visible')
    } catch {
      // Layer may not support layout visibility in this style build.
    }
  }
}
