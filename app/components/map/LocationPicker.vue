<script lang="ts" setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { MapInstance } from '~~/shared/types/map'

interface PlaceHit {
  latitude: number
  longitude: number
  label: string
  country?: string
  city?: string
  province?: string
  placeType?: string
}

/** 按行政层级决定飞到该点后的缩放级别 */
function zoomForPlaceType(placeType?: string): number {
  switch (placeType) {
    case 'province':
      return 7
    case 'city':
      return 10
    case 'district':
      return 12
    case 'town':
      return 13
    case 'landmark':
    case 'poi':
      return 14
    default:
      return 12
  }
}

const PLACE_TYPE_LABEL: Record<string, string> = {
  province: '省级',
  city: '地级市',
  district: '区县',
  town: '乡镇',
  landmark: '景点',
  poi: '地点',
  other: '其他',
}

function placeTypeLabel(placeType?: string): string {
  if (!placeType) return ''
  return PLACE_TYPE_LABEL[placeType] || placeType
}

/** 未选点时默认对准中国河南省郑州市 */
const DEFAULT_CENTER: [number, number] = [113.625368, 34.7466]
const DEFAULT_ZOOM = 10

const props = withDefaults(
  defineProps<{
    modelValue?: { latitude: number; longitude: number } | null
    zoom?: number
    class?: string
  }>(),
  {
    modelValue: null,
    zoom: DEFAULT_ZOOM,
    class: undefined,
  },
)

const emit = defineEmits<{
  'update:modelValue': [{ latitude: number; longitude: number } | null]
  pick: [{ latitude: number; longitude: number }]
}>()

const { t, locale } = useI18n()
const toast = useToast()

const mapInstance = ref<MapInstance | null>(null)
const expandedMapInstance = ref<MapInstance | null>(null)
const markerCoordinates = ref<[number, number] | null>(null)
const expandedOpen = ref(false)

const mapCenter = computed(
  (): [number, number] => markerCoordinates.value ?? DEFAULT_CENTER,
)
const mapZoom = computed(() =>
  markerCoordinates.value
    ? Math.max(props.zoom ?? DEFAULT_ZOOM, 10)
    : (props.zoom ?? DEFAULT_ZOOM),
)
const expandedMapZoom = computed(() =>
  markerCoordinates.value
    ? Math.max(props.zoom ?? DEFAULT_ZOOM, 12)
    : (props.zoom ?? DEFAULT_ZOOM),
)

const searchQuery = ref('')
const searchHits = ref<PlaceHit[]>([])
const searchLoading = ref(false)
const searchOpen = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let compactClickHandler: ((event: any) => void) | null = null
let expandedClickHandler: ((event: any) => void) | null = null

const syncFromProps = (
  value: { latitude: number; longitude: number } | null,
) => {
  if (value) {
    markerCoordinates.value = [value.longitude, value.latitude]
    flyBoth(markerCoordinates.value, Math.max(props.zoom ?? DEFAULT_ZOOM, 10))
  } else {
    markerCoordinates.value = null
    flyBoth(DEFAULT_CENTER, props.zoom ?? DEFAULT_ZOOM)
  }
}

watch(
  () => props.modelValue,
  (value) => {
    syncFromProps(value ?? null)
  },
  { immediate: true },
)

watch(expandedOpen, async (open) => {
  if (!open) return
  await nextTick()
  resizeMap(expandedMapInstance.value)
  flyMap(
    expandedMapInstance.value,
    mapCenter.value,
    expandedMapZoom.value,
  )
})

const flyMap = (
  map: MapInstance | null,
  center: [number, number],
  zoom: number,
) => {
  if (!map) return
  const anyMap: any = map
  anyMap.flyTo?.({ center, zoom, essential: true })
}

const flyBoth = (center: [number, number], zoom: number) => {
  flyMap(mapInstance.value, center, zoom)
  flyMap(expandedMapInstance.value, center, zoom)
}

const resizeMap = (map: MapInstance | null) => {
  if (!map) return
  const anyMap: any = map
  anyMap.resize?.()
  // Mapbox GL uses the same method name.
  requestAnimationFrame(() => anyMap.resize?.())
}

const updateValue = (
  latitude: number,
  longitude: number,
  shouldEmitPick = true,
  zoom = 14,
) => {
  markerCoordinates.value = [longitude, latitude]
  emit('update:modelValue', { latitude, longitude })
  if (shouldEmitPick) {
    emit('pick', { latitude, longitude })
  }
  flyBoth(markerCoordinates.value, zoom)
}

const handleMapClick = (event: any) => {
  const point =
    event?.lngLat ||
    event?.latlng ||
    (Array.isArray(event) ? { lng: event[0], lat: event[1] } : null)
  if (!point) return
  const latitude =
    typeof point.lat === 'number' ? point.lat : (point.latitude ?? point[1])
  const longitude =
    typeof point.lng === 'number' ? point.lng : (point.longitude ?? point[0])
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return
  updateValue(latitude, longitude)
}

const bindClick = (
  map: MapInstance,
  slot: 'compact' | 'expanded',
) => {
  const anyMap: any = map
  if (typeof anyMap.on !== 'function') return
  const handler = (event: any) => handleMapClick(event)
  if (slot === 'compact') {
    if (compactClickHandler && mapInstance.value) {
      ;(mapInstance.value as any).off?.('click', compactClickHandler)
    }
    compactClickHandler = handler
  } else {
    if (expandedClickHandler && expandedMapInstance.value) {
      ;(expandedMapInstance.value as any).off?.('click', expandedClickHandler)
    }
    expandedClickHandler = handler
  }
  anyMap.on('click', handler)
}

const onCompactLoad = (map: MapInstance) => {
  mapInstance.value = map
  const anyMap: any = map
  anyMap.setCenter?.(mapCenter.value)
  anyMap.setZoom?.(mapZoom.value)
  bindClick(map, 'compact')
}

const onExpandedLoad = (map: MapInstance) => {
  expandedMapInstance.value = map
  const anyMap: any = map
  anyMap.setCenter?.(mapCenter.value)
  anyMap.setZoom?.(expandedMapZoom.value)
  bindClick(map, 'expanded')
  resizeMap(map)
}

const runSearch = async () => {
  const q = searchQuery.value.trim()
  if (!q) {
    searchHits.value = []
    searchOpen.value = false
    return
  }
  searchLoading.value = true
  try {
    const response = await $fetch<{ items: PlaceHit[] }>('/api/location/search', {
      query: { q, limit: 20 },
    })
    searchHits.value = response.items || []
    searchOpen.value = true
  } catch (error) {
    console.error('Location search failed:', error)
    searchHits.value = []
    searchOpen.value = false
    toast.add({
      title: t('dashboard.photos.editModal.fields.locationSearchFailed'),
      color: 'error',
    })
  } finally {
    searchLoading.value = false
  }
}

const onSearchInput = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    void runSearch()
  }, 400)
}

const pickHit = (hit: PlaceHit) => {
  searchQuery.value = hit.label
  searchOpen.value = false
  updateValue(
    hit.latitude,
    hit.longitude,
    true,
    zoomForPlaceType(hit.placeType),
  )
}

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  if (mapInstance.value && compactClickHandler) {
    ;(mapInstance.value as any).off?.('click', compactClickHandler)
  }
  if (expandedMapInstance.value && expandedClickHandler) {
    ;(expandedMapInstance.value as any).off?.('click', expandedClickHandler)
  }
})
</script>

<template>
  <div class="space-y-2">
    <div class="relative">
      <UInput
        v-model="searchQuery"
        icon="tabler:search"
        :loading="searchLoading"
        :placeholder="$t('dashboard.photos.editModal.fields.locationSearch')"
        autocomplete="off"
        @update:model-value="onSearchInput"
        @keydown.enter.prevent="runSearch"
      />
      <div
        v-if="searchOpen"
        class="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      >
        <p
          v-if="!searchLoading && searchHits.length === 0"
          class="px-3 py-2 text-sm text-neutral-500"
        >
          {{ $t('dashboard.photos.editModal.fields.locationSearchEmpty') }}
        </p>
        <button
          v-for="hit in searchHits"
          :key="`${hit.latitude},${hit.longitude},${hit.label}`"
          type="button"
          class="block w-full border-b border-neutral-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800"
          @click="pickHit(hit)"
        >
          <span class="line-clamp-2 text-neutral-900 dark:text-neutral-100">
            {{ hit.label }}
          </span>
          <span
            v-if="placeTypeLabel(hit.placeType)"
            class="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400"
          >
            {{ placeTypeLabel(hit.placeType) }}
          </span>
        </button>
      </div>
    </div>

    <div
      :class="[
        'relative w-full h-64 rounded-xl overflow-hidden',
        $props.class,
      ]"
    >
      <MapProvider
        class="w-full h-full"
        :map-id="'photo-location-picker'"
        :center="mapCenter"
        :zoom="mapZoom"
        :interactive="true"
        :language="locale"
        @load="onCompactLoad"
      >
        <MapProviderMarker
          v-if="markerCoordinates"
          :lnglat="markerCoordinates"
        >
          <template #marker>
            <div class="relative">
              <div
                class="absolute inset-0 animate-ping rounded-full bg-primary/40"
              />
              <div
                class="relative size-4 rounded-full bg-primary border-2 border-white shadow"
              />
            </div>
          </template>
        </MapProviderMarker>
      </MapProvider>

      <div
        v-if="!markerCoordinates"
        class="absolute inset-0 pointer-events-none flex items-center justify-center text-sm text-neutral-600 dark:text-neutral-400"
      >
        <slot name="empty" />
      </div>

      <UButton
        class="absolute top-2 right-2 z-10"
        size="xs"
        color="neutral"
        variant="solid"
        icon="tabler:arrows-maximize"
        @click="expandedOpen = true"
      >
        {{ $t('dashboard.photos.editModal.fields.expandMap') }}
      </UButton>
    </div>

    <UModal
      v-model:open="expandedOpen"
      :ui="{ content: 'sm:max-w-5xl' }"
    >
      <template #content>
        <div class="flex max-h-[90vh] flex-col gap-3 p-4 sm:p-6">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="text-lg font-semibold">
                {{ $t('dashboard.photos.editModal.fields.location') }}
              </h3>
              <p class="mt-1 text-sm text-neutral-500">
                {{ $t('dashboard.photos.editModal.fields.locationHint') }}
              </p>
            </div>
            <UButton
              color="neutral"
              variant="ghost"
              icon="tabler:x"
              @click="expandedOpen = false"
            />
          </div>

          <div class="relative">
            <UInput
              v-model="searchQuery"
              icon="tabler:search"
              :loading="searchLoading"
              :placeholder="$t('dashboard.photos.editModal.fields.locationSearch')"
              autocomplete="off"
              @update:model-value="onSearchInput"
              @keydown.enter.prevent="runSearch"
            />
            <div
              v-if="searchOpen"
              class="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            >
              <p
                v-if="!searchLoading && searchHits.length === 0"
                class="px-3 py-2 text-sm text-neutral-500"
              >
                {{ $t('dashboard.photos.editModal.fields.locationSearchEmpty') }}
              </p>
              <button
                v-for="hit in searchHits"
                :key="`expanded-${hit.latitude},${hit.longitude},${hit.label}`"
                type="button"
                class="block w-full border-b border-neutral-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800"
                @click="pickHit(hit)"
              >
                <span class="line-clamp-2 text-neutral-900 dark:text-neutral-100">
                  {{ hit.label }}
                </span>
                <span
                  v-if="placeTypeLabel(hit.placeType)"
                  class="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400"
                >
                  {{ placeTypeLabel(hit.placeType) }}
                </span>
              </button>
            </div>
          </div>

          <div
            class="relative h-[min(70vh,560px)] w-full overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800"
          >
            <MapProvider
              v-if="expandedOpen"
              class="w-full h-full"
              :map-id="'photo-location-picker-expanded'"
              :center="mapCenter"
              :zoom="expandedMapZoom"
              :interactive="true"
              :language="locale"
              @load="onExpandedLoad"
            >
              <MapProviderMarker
                v-if="markerCoordinates"
                :lnglat="markerCoordinates"
              >
                <template #marker>
                  <div class="relative">
                    <div
                      class="absolute inset-0 animate-ping rounded-full bg-primary/40"
                    />
                    <div
                      class="relative size-4 rounded-full bg-primary border-2 border-white shadow"
                    />
                  </div>
                </template>
              </MapProviderMarker>
            </MapProvider>
          </div>

          <div class="flex justify-end">
            <UButton
              color="primary"
              icon="tabler:check"
              @click="expandedOpen = false"
            >
              {{ $t('dashboard.photos.editModal.fields.confirmLocation') }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
