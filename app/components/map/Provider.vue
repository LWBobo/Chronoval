<script lang="ts" setup>
import type { AttributionControlOptions, StyleSpecification } from 'maplibre-gl'
import { twMerge } from 'tailwind-merge'
import type { MapboxMap, MapInstance, MaplibreMap } from '~~/shared/types/map'
import { protomapsLang, protomapsStyle } from '~/utils/protomapsStyle'
import {
  DEFAULT_PMTILES_FILE,
  mapPmtilesFilename,
} from '~~/shared/map-pmtiles'

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
  }>(),
  {
    class: undefined,
    mapId: undefined,
    center: undefined,
    zoom: 2,
    interactive: true,
    attributionControl: false,
    language: undefined,
  },
)

const emit = defineEmits<{
  load: [map: MapInstance]
  zoom: []
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
// Attribution is applied only when the map is created, so a provider
// change has to remount. MapLibre and Protomaps share one component.
const mapInstanceKey = computed(() =>
  provider.value === 'protomaps' ? `protomaps:${pmtilesFile.value}` : 'maplibre',
)
const mapAttribution = computed(() =>
  provider.value === 'protomaps' ? { compact: false } : props.attributionControl,
)
const mapStyle = computed(() => {
  if (provider.value === 'mapbox') {
    return mapConfig.value['mapbox.style'] || `mapbox://styles/mapbox/standard`
  }
  if (provider.value === 'protomaps') {
    const origin =
      typeof window === 'undefined' ? '' : window.location.origin
    return protomapsStyle({
      dark: colorMode.value === 'dark',
      lang: protomapsLang(locale.value),
      tileUrl: `pmtiles://${origin}/map/pmtiles?file=${encodeURIComponent(pmtilesFile.value)}`,
    })
  }
  const styleConfig =
    colorMode.value === 'dark' ? ChronoFrameDarkStyle : ChronoFrameLightStyle
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
      glyphs: `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=${mapConfig.value['maplibre.token']}`,
    } as StyleSpecification)
  )
})
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
        @map:load="emit('load', $event.map as MaplibreMap)"
        @map:zoom="emit('zoom')"
      >
        <slot />
      </MglMap>
      <MapboxMap
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
        @load="emit('load', $event as MapboxMap)"
        @zoom="emit('zoom')"
      >
        <slot />
      </MapboxMap>
    </ClientOnly>
  </div>
</template>

<style scoped></style>
