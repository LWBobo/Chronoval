<script lang="ts" setup>
import type { AttributionControlOptions, StyleSpecification } from 'maplibre-gl'
import { twMerge } from 'tailwind-merge'
import type { MapboxMap, MapInstance, MaplibreMap } from '~~/shared/types/map'
import type { ResolvedTimelineNetworkMode } from '~/utils/mapNetworkProfile'
import { protomapsLang, protomapsStyle } from '~/utils/protomapsStyle'
import { DEFAULT_PMTILES_FILE, mapPmtilesFilename } from '~~/shared/map-pmtiles'

import ChronoFrameLightStyle from '~/assets/mapStyles/chronoframe_light.json'
import ChronoFrameDarkStyle from '~/assets/mapStyles/chronoframe_dark.json'

const props = withDefaults(
  defineProps<{
    class?: string
    mapId?: string
    center?: [number, number]
    zoom?: number
    interactive?: boolean
    attributionControl?: false | AttributionControlOptions
    language?: string
    networkMode?: ResolvedTimelineNetworkMode
    preferLiteMap?: boolean
  }>(),
  {
    class: undefined,
    mapId: undefined,
    center: undefined,
    zoom: 2,
    interactive: true,
    attributionControl: false,
    language: undefined,
    networkMode: 'smooth',
    preferLiteMap: false,
  },
)

const emit = defineEmits<{
  load: [map: MapInstance]
  zoom: []
  userInteraction: []
  idle: []
}>()

const colorMode = useColorMode()
const { locale } = useI18n()

const mapConfig = computed(() => {
  const config = getSetting('map')
  return typeof config === 'object' && config ? config : {}
})

const provider = computed(() => mapConfig.value.provider || 'maplibre')
const pmtilesFile = computed(() => {
  try {
    return mapPmtilesFilename(
      mapConfig.value['protomaps.file'] == null
        ? undefined
        : String(mapConfig.value['protomaps.file']),
    )
  } catch {
    return DEFAULT_PMTILES_FILE
  }
})
const timelinePmtilesFile = computed(() => {
  const raw = mapConfig.value['protomaps.timelineFile']
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    return mapPmtilesFilename(raw)
  } catch {
    return null
  }
})
const activePmtilesFile = computed(() =>
  props.preferLiteMap && timelinePmtilesFile.value
    ? timelinePmtilesFile.value
    : pmtilesFile.value,
)
// Attribution is applied only when the map is created, so a provider
// change has to remount. MapLibre and Protomaps share one component.
const mapInstanceKey = computed(() =>
  provider.value === 'protomaps'
    ? `protomaps:${activePmtilesFile.value}`
    : 'maplibre',
)
const mapAttribution = computed(() =>
  provider.value === 'protomaps'
    ? { compact: false }
    : props.attributionControl,
)
const mapStyle = computed(() => {
  if (provider.value === 'mapbox') {
    return mapConfig.value['mapbox.style'] || `mapbox://styles/mapbox/standard`
  }
  if (provider.value === 'protomaps') {
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    return protomapsStyle({
      dark: colorMode.value === 'dark',
      lang: protomapsLang(locale.value),
      tileUrl: `pmtiles://${origin}/map/pmtiles?file=${encodeURIComponent(activePmtilesFile.value)}`,
      assetBase: origin,
    })
  }
  const styleConfig =
    colorMode.value === 'dark' ? ChronoFrameDarkStyle : ChronoFrameLightStyle
  // Glyphs/sprites are vendored under public/map; only the vector tiles still
  // need MapTiler (or a custom maplibre.style URL). Prefer protomaps offline.
  const assetOrigin =
    typeof window === 'undefined' ? '' : window.location.origin
  return (
    mapConfig.value['maplibre.style'] ||
    ({
      ...styleConfig,
      sources: {
        openmaptiles: {
          ...styleConfig.sources?.openmaptiles,
          url: `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${mapConfig.value['maplibre.token']}`,
        },
      },
      glyphs: `${assetOrigin}/map/basemaps-assets/fonts/{fontstack}/{range}.pbf`,
      sprite: `${assetOrigin}/map/openmaptiles-sprite/sprite`,
    } as StyleSpecification)
  )
})

const onMaplibreLoad = (map: MaplibreMap) => {
  bindMapEvents(map)
  emit('load', map)
}

const bindMapEvents = (map: MapInstance) => {
  map.on('dragstart', () => emit('userInteraction'))
  map.on('rotatestart', () => emit('userInteraction'))
  map.on('pitchstart', () => emit('userInteraction'))
  map.on('idle', () => emit('idle'))
}

const onMapboxLoad = (map: MapboxMap) => {
  bindMapEvents(map)
  emit('load', map)
}
</script>

<template>
  <div :class="twMerge('w-full h-full', props.class)">
    <ClientOnly>
      <MglMap
        v-if="provider !== 'mapbox'"
        :key="mapInstanceKey"
        class="w-full h-full"
        :map-key="mapId"
        :map-style="mapStyle as StyleSpecification"
        :center
        :zoom
        :interactive
        :attribution-control="mapAttribution"
        :fade-duration="0"
        :max-tile-cache-size="1000"
        :prefetch-zoom-delta="networkMode === 'save-data' ? 0 : 2"
        :refresh-expired-tiles="false"
        local-ideograph-font-family='"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
        @map:load="onMaplibreLoad($event.map as MaplibreMap)"
        @map:zoom="emit('zoom')"
      >
        <slot />
      </MglMap>
      <LazyMapboxMap
        v-else
        class="w-full h-full"
        :map-id="mapId || 'cframe-mapbox-map'"
        :options="{
          accessToken: mapConfig['mapbox.token'],
          style: mapStyle,
          center: center,
          zoom: zoom,
          interactive: interactive,
          attributionControl: attributionControl,
          language: language,
          config: {
            basemap: {
              lightPreset: $colorMode.value === 'dark' ? 'night' : 'day',
              colorThemes: 'faded',
            },
          },
        }"
        @load="onMapboxLoad($event as MapboxMap)"
        @zoom="emit('zoom')"
      >
        <slot />
      </LazyMapboxMap>
    </ClientOnly>
  </div>
</template>

<style scoped></style>
