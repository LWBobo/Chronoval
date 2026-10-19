<script lang="ts" setup>
import { motion } from 'motion-v'
import { clusterMarkers, photosToMarkers } from '~/utils/clustering'

useHead({
  title: () => $t('title.globe'),
})

const route = useRoute()
const router = useRouter()
const dayjs = useDayjs()

const { photos } = usePhotos()

const photosWithLocation = computed(() => {
  return photos.value.filter(
    (photo) =>
      photo.latitude !== null &&
      photo.longitude !== null &&
      photo.latitude !== undefined &&
      photo.longitude !== undefined,
  )
})

const timelineProgress = ref(100)
const isTimelineEnabled = ref(false)
const isTimelinePlaying = ref(false)
const isTimelineDragging = ref(false)
const isTimelineFollow = ref(true)
const timelineTrackRef = ref<HTMLElement | null>(null)
const timelinePlayDurationMs = 12000
let timelineAnimationFrame: number | null = null
let timelineLastTick = 0
let cameraScripted = false
let playbackToken = 0
let idleCleanup: (() => void) | null = null
let scriptedPhase: 'travel' | 'dwell' = 'travel'
let phaseStart = 0
let phaseDuration = 1
let phaseFrom = 0
let phaseTo = 0
let placeCursor = 0
let mapSettled = false

const datedPhotosWithLocation = computed(() => {
  return photosWithLocation.value
    .map((photo) => {
      const timestamp = photo.dateTaken
        ? new Date(photo.dateTaken).getTime()
        : Number.NaN
      return {
        photo,
        timestamp,
      }
    })
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
})

const hasTimelineData = computed(() => datedPhotosWithLocation.value.length > 1)

const timelineRange = computed(() => {
  if (!hasTimelineData.value) {
    return null
  }

  const first = datedPhotosWithLocation.value[0]!
  const last = datedPhotosWithLocation.value[datedPhotosWithLocation.value.length - 1]!
  return {
    min: first.timestamp,
    max: last.timestamp,
  }
})

const timelineCutoffTimestamp = computed(() => {
  if (!timelineRange.value) {
    return null
  }

  const ratio = timelineProgress.value / 100
  return Math.round(
    timelineRange.value.min +
      (timelineRange.value.max - timelineRange.value.min) * ratio,
  )
})

const filteredPhotosWithLocation = computed(() => {
  if (!isTimelineEnabled.value) {
    return photosWithLocation.value
  }

  if (!timelineCutoffTimestamp.value) {
    return photosWithLocation.value
  }

  return photosWithLocation.value.filter((photo) => {
    if (!photo.dateTaken) {
      return true
    }
    const timestamp = new Date(photo.dateTaken).getTime()
    if (!Number.isFinite(timestamp)) {
      return true
    }
    return timestamp <= timelineCutoffTimestamp.value!
  })
})

const timelineStartLabel = computed(() => {
  if (!timelineRange.value) {
    return '--'
  }
  return dayjs(timelineRange.value.min).format('YYYY-MM-DD')
})

const timelineEndLabel = computed(() => {
  if (!timelineRange.value) {
    return '--'
  }
  return dayjs(timelineRange.value.max).format('YYYY-MM-DD')
})

const timelineCurrentLabel = computed(() => {
  if (!timelineCutoffTimestamp.value) {
    return '--'
  }
  return dayjs(timelineCutoffTimestamp.value).format('YYYY-MM-DD')
})

const timelineProgressStyle = computed(() => `${timelineProgress.value}%`)

const clampProgress = (value: number) => {
  return Math.min(100, Math.max(0, value))
}

const updateTimelineProgressByClientX = (clientX: number) => {
  if (!timelineTrackRef.value) {
    return
  }

  const rect = timelineTrackRef.value.getBoundingClientRect()
  if (rect.width <= 0) {
    return
  }

  const ratio = (clientX - rect.left) / rect.width
  timelineProgress.value = clampProgress(ratio * 100)
}

const stopTimelineDragging = () => {
  isTimelineDragging.value = false
  window.removeEventListener('pointermove', onTimelinePointerMove)
  window.removeEventListener('pointerup', onTimelinePointerUp)
}

const onTimelinePointerMove = (event: PointerEvent) => {
  if (!isTimelineDragging.value) {
    return
  }
  updateTimelineProgressByClientX(event.clientX)
}

const onTimelinePointerUp = () => {
  stopTimelineDragging()
}

const onTimelinePointerDown = (event: PointerEvent) => {
  if (!isTimelineEnabled.value || !hasTimelineData.value) {
    return
  }

  stopTimelinePlayback()
  isTimelineDragging.value = true
  updateTimelineProgressByClientX(event.clientX)
  window.addEventListener('pointermove', onTimelinePointerMove)
  window.addEventListener('pointerup', onTimelinePointerUp)
}

const clearMapSettleWait = () => {
  idleCleanup?.()
  idleCleanup = null
}

const stopTimelinePlayback = () => {
  isTimelinePlaying.value = false
  cameraScripted = false
  playbackToken += 1
  clearMapSettleWait()
  if (timelineAnimationFrame !== null) {
    cancelAnimationFrame(timelineAnimationFrame)
    timelineAnimationFrame = null
  }
}

const tickTimelinePlayback = (now: number) => {
  if (!isTimelinePlaying.value) {
    return
  }

  if (cameraScripted) {
    tickScriptedPlayback(now)
    return
  }

  const delta = now - timelineLastTick
  timelineLastTick = now

  const progressDelta = (delta / timelinePlayDurationMs) * 100
  const nextProgress = clampProgress(timelineProgress.value + progressDelta)
  timelineProgress.value = nextProgress

  if (nextProgress >= 100) {
    stopTimelinePlayback()
    return
  }

  timelineAnimationFrame = requestAnimationFrame(tickTimelinePlayback)
}

const startTimelinePlayback = () => {
  if (!hasTimelineData.value) {
    return
  }

  const restarted = timelineProgress.value >= 100
  if (restarted) {
    timelineProgress.value = 0
  }

  isTimelinePlaying.value = true
  timelineLastTick = performance.now()
  if (isTimelineFollow.value) {
    startScriptedPlayback(restarted)
  } else {
    cameraScripted = false
  }
  timelineAnimationFrame = requestAnimationFrame(tickTimelinePlayback)
}

const toggleTimelinePlayback = () => {
  if (!isTimelineEnabled.value) {
    return
  }

  if (isTimelinePlaying.value) {
    stopTimelinePlayback()
    return
  }
  startTimelinePlayback()
}

const toggleTimelineEnabled = () => {
  if (isTimelineEnabled.value) {
    stopTimelineDragging()
    stopTimelinePlayback()
    stopTimelineFollowCamera()
    isTimelineEnabled.value = false
    return
  }

  isTimelineEnabled.value = true
}

const PLACE_RADIUS_KM = 40

const distanceKm = (
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) => {
  const toRad = Math.PI / 180
  const dLat = (latitudeB - latitudeA) * toRad
  const dLng = (longitudeB - longitudeA) * toRad
  const lat1 = latitudeA * toRad
  const lat2 = latitudeB * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

type TimelinePlace = {
  id: string
  index: number
  photos: { photo: (typeof datedPhotosWithLocation.value)[number]['photo']; timestamp: number }[]
}

const timelinePlaces = computed(() => {
  const places: TimelinePlace[] = []
  for (const entry of datedPhotosWithLocation.value) {
    const latitude = entry.photo.latitude
    const longitude = entry.photo.longitude
    if (latitude == null || longitude == null) continue
    const current = places[places.length - 1]
    const anchor = current?.photos[0]?.photo
    const samePlace =
      current &&
      anchor?.latitude != null &&
      anchor.longitude != null &&
      distanceKm(anchor.latitude, anchor.longitude, latitude, longitude) <=
        PLACE_RADIUS_KM
    if (current && samePlace) {
      current.photos.push(entry)
      continue
    }
    places.push({
      id: entry.photo.id,
      index: places.length,
      photos: [entry],
    })
  }
  return places
})

const activeTimelinePlace = computed(() => {
  if (!isTimelineEnabled.value || timelineCutoffTimestamp.value == null) {
    return null
  }
  const cutoff = timelineCutoffTimestamp.value
  let active: TimelinePlace | null = null
  for (const place of timelinePlaces.value) {
    if (place.photos[0]!.timestamp <= cutoff) active = place
  }
  return active
})

let followedPlaceId: string | null = null

const frameForPlace = (place: TimelinePlace) => {
  const latitudes = place.photos.map((entry) => entry.photo.latitude!)
  const longitudes = place.photos.map((entry) => entry.photo.longitude!)
  const minLat = Math.min(...latitudes)
  const maxLat = Math.max(...latitudes)
  const minLng = Math.min(...longitudes)
  const maxLng = Math.max(...longitudes)
  const maxDiff = Math.max(maxLat - minLat, maxLng - minLng)
  let zoom = 13.5
  if (maxDiff < 0.02) zoom = 14
  else if (maxDiff < 0.08) zoom = 12.5
  else if (maxDiff < 0.25) zoom = 11
  else if (maxDiff < 0.8) zoom = 9.5
  else zoom = 8
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    zoom,
  }
}

const progressForTimestamp = (timestamp: number) => {
  const range = timelineRange.value
  if (!range || range.max <= range.min) return 100
  return clampProgress(((timestamp - range.min) / (range.max - range.min)) * 100)
}

const glideDuration = (distance: number, dragging: boolean) => {
  const base = dragging ? 3600 : 6500
  const extra = Math.min(dragging ? 1600 : 4500, distance * 1.1)
  return Math.round(Math.min(dragging ? 5600 : 12000, base + extra))
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

const placeIndexForCutoff = (cutoff: number) => {
  let index = 0
  for (const place of timelinePlaces.value) {
    if (place.photos[0]!.timestamp <= cutoff) index = place.index
  }
  return index
}

const distanceToPlace = (place: TimelinePlace) => {
  const map = mapInstance.value
  if (!map?.getCenter) return 0
  const frame = frameForPlace(place)
  const center = map.getCenter()
  return distanceKm(center.lat, center.lng, frame.latitude, frame.longitude)
}

const armMapSettle = (token: number, flightMs: number) => {
  clearMapSettleWait()
  mapSettled = false
  const map = mapInstance.value
  if (!map?.on) {
    mapSettled = true
    return
  }
  let moveEnded = false
  const started = performance.now()
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const onMoveEnd = () => {
    if (token !== playbackToken || moveEnded) return
    if (performance.now() - started < flightMs * 0.8) return
    moveEnded = true
    settleTimer = setTimeout(() => {
      if (token === playbackToken) mapSettled = true
    }, 450)
  }
  const onIdle = () => {
    if (token !== playbackToken || !moveEnded) return
    mapSettled = true
  }
  map.on('moveend', onMoveEnd)
  map.on('idle', onIdle)
  const timer = setTimeout(() => {
    if (token === playbackToken) mapSettled = true
  }, flightMs + 700)
  idleCleanup = () => {
    clearTimeout(timer)
    if (settleTimer) clearTimeout(settleTimer)
    map.off?.('moveend', onMoveEnd)
    map.off?.('idle', onIdle)
  }
}

const flyToTimelinePlace = (place: TimelinePlace, duration: number) => {
  const map = mapInstance.value
  if (!map?.flyTo || !map.getCenter || !map.getZoom) return 0
  const frame = frameForPlace(place)
  const center = map.getCenter()
  const distance = distanceKm(
    center.lat,
    center.lng,
    frame.latitude,
    frame.longitude,
  )
  const options: Record<string, unknown> = {
    center: [frame.longitude, frame.latitude],
    zoom: frame.zoom,
    essential: true,
    duration,
    curve: 1.05,
    padding: { top: 48, bottom: 140, left: 48, right: 48 },
  }
  if (distance < 800) {
    options.minZoom = Math.max(2, Math.min(map.getZoom(), frame.zoom) - 1.1)
  }
  followedPlaceId = place.id
  map.flyTo(options)
  return distance
}

const beginScriptedPlace = (index: number, now: number) => {
  const place = timelinePlaces.value[index]
  if (!place) {
    timelineProgress.value = 100
    stopTimelinePlayback()
    return
  }
  placeCursor = index
  scriptedPhase = 'travel'
  phaseStart = now
  phaseFrom = timelineProgress.value
  const firstTimestamp = place.photos[0]!.timestamp
  const rangeMin = timelineRange.value?.min ?? firstTimestamp
  // Hold just before the first photo, so pins appear only after the camera has settled.
  phaseTo = progressForTimestamp(Math.max(rangeMin, firstTimestamp - 1))
  const distance = distanceToPlace(place)
  if (distance < 0.4) {
    phaseDuration = 500
    mapSettled = true
    followedPlaceId = place.id
    return
  }
  phaseDuration = Math.max(glideDuration(distance, false), 6500)
  playbackToken += 1
  armMapSettle(playbackToken, phaseDuration)
  flyToTimelinePlace(place, phaseDuration)
}

const startScriptedDwell = (now: number, fromTimestamp?: number) => {
  const place = timelinePlaces.value[placeCursor]
  if (!place) {
    stopTimelinePlayback()
    return
  }
  const next = timelinePlaces.value[placeCursor + 1]
  const endTimestamp = next
    ? next.photos[0]!.timestamp - 1
    : (timelineRange.value?.max ?? place.photos[place.photos.length - 1]!.timestamp)
  scriptedPhase = 'dwell'
  phaseStart = now
  phaseFrom = fromTimestamp == null
    ? timelineProgress.value
    : progressForTimestamp(fromTimestamp)
  phaseTo = Math.max(phaseFrom, progressForTimestamp(endTimestamp))
  const extraPhotos = Math.max(0, place.photos.length - 1)
  phaseDuration = Math.min(8800, 1600 + extraPhotos * 110)
  timelineProgress.value = phaseFrom
}

const startScriptedPlayback = (restarted: boolean) => {
  cameraScripted = true
  clearMapSettleWait()
  const places = timelinePlaces.value
  if (!places.length) {
    stopTimelinePlayback()
    return
  }
  const now = performance.now()
  if (restarted) {
    beginScriptedPlace(0, now)
    return
  }
  const cutoff = timelineCutoffTimestamp.value ?? places[0]!.photos[0]!.timestamp
  const index = placeIndexForCutoff(cutoff)
  const place = places[index]!
  const next = places[index + 1]
  const finished = next
    ? cutoff >= next.photos[0]!.timestamp
    : timelineProgress.value >= 99.5
  if (cutoff >= place.photos[0]!.timestamp && !finished) {
    placeCursor = index
    followedPlaceId = place.id
    startScriptedDwell(now, cutoff)
    return
  }
  beginScriptedPlace(index, now)
}

const tickScriptedPlayback = (now: number) => {
  const t = Math.min(1, (now - phaseStart) / Math.max(phaseDuration, 1))
  const eased = scriptedPhase === 'travel' ? easeOutCubic(t) : t
  timelineProgress.value = phaseFrom + (phaseTo - phaseFrom) * eased

  if (scriptedPhase === 'travel' && t >= 1 && mapSettled) {
    timelineProgress.value = phaseTo
    startScriptedDwell(now)
  } else if (scriptedPhase === 'dwell' && t >= 1) {
    beginScriptedPlace(placeCursor + 1, now)
  }

  if (!isTimelinePlaying.value) return
  timelineAnimationFrame = requestAnimationFrame(tickTimelinePlayback)
}

const stopTimelineFollowCamera = () => {
  followedPlaceId = null
  mapInstance.value?.stop?.()
}

const syncTimelineCamera = (force = false) => {
  if (cameraScripted) return
  if (!isTimelineFollow.value || !isTimelineEnabled.value) return
  if (!force && !isTimelinePlaying.value && !isTimelineDragging.value) return
  const place = activeTimelinePlace.value
  if (!place) return
  if (!force && place.id === followedPlaceId) return
  flyToTimelinePlace(
    place,
    glideDuration(distanceToPlace(place), isTimelineDragging.value),
  )
}

const toggleTimelineFollow = () => {
  isTimelineFollow.value = !isTimelineFollow.value
  if (!isTimelineFollow.value) {
    cameraScripted = false
    playbackToken += 1
    clearMapSettleWait()
    stopTimelineFollowCamera()
    timelineLastTick = performance.now()
    return
  }
  if (isTimelinePlaying.value) {
    startScriptedPlayback(false)
    return
  }
  syncTimelineCamera(true)
}

watch(
  () => activeTimelinePlace.value?.id,
  () => {
    if (cameraScripted) return
    syncTimelineCamera(false)
  },
)

const currentClusterPointId = ref<string | null>(null)
const mapInstance = ref<any>(null)
const currentZoom = ref<number>(4)
const analysisMode = ref<'none' | 'focalLength' | 'shutterSpeed' | 'altitude'>(
  'none',
)
const parameterAnnotationOpen = ref(false)

const analysisModeOptions = computed(() => [
  {
    value: 'none',
    label: $t('globe.analysis.mode.none.label'),
    icon: 'tabler:circle-off',
    description: $t('globe.analysis.mode.none.description'),
  },
  {
    value: 'focalLength',
    label: $t('globe.analysis.mode.focalLength.label'),
    icon: 'tabler:zoom-scan',
    description: $t('globe.analysis.mode.focalLength.description'),
  },
  {
    value: 'shutterSpeed',
    label: $t('globe.analysis.mode.shutterSpeed.label'),
    icon: 'tabler:clock-hour-4',
    description: $t('globe.analysis.mode.shutterSpeed.description'),
  },
  {
    value: 'altitude',
    label: $t('globe.analysis.mode.altitude.label'),
    icon: 'tabler:mountain',
    description: $t('globe.analysis.mode.altitude.description'),
  },
] as const)

const analysisLegend = computed(() => {
  if (analysisMode.value === 'focalLength') {
    return {
      title: $t('globe.analysis.legend.focalLength.title'),
      items: [
        {
          label: $t('globe.analysis.legend.focalLength.wide'),
          range: '<35mm',
          color: 'bg-cyan-500',
        },
        {
          label: $t('globe.analysis.legend.focalLength.standard'),
          range: '35-85mm',
          color: 'bg-amber-500',
        },
        {
          label: $t('globe.analysis.legend.focalLength.telephoto'),
          range: '>85mm',
          color: 'bg-rose-500',
        },
      ],
    }
  }

  if (analysisMode.value === 'shutterSpeed') {
    return {
      title: $t('globe.analysis.legend.shutterSpeed.title'),
      items: [
        {
          label: $t('globe.analysis.legend.shutterSpeed.fast'),
          range: '≤1/250s',
          color: 'bg-emerald-500',
        },
        {
          label: $t('globe.analysis.legend.shutterSpeed.medium'),
          range: '1/250-1/30s',
          color: 'bg-amber-500',
        },
        {
          label: $t('globe.analysis.legend.shutterSpeed.slow'),
          range: '>1/30s',
          color: 'bg-indigo-500',
        },
      ],
    }
  }

  if (analysisMode.value === 'altitude') {
    return {
      title: $t('globe.analysis.legend.altitude.title'),
      items: [
        {
          label: $t('globe.analysis.legend.altitude.low'),
          range: '<200m',
          color: 'bg-lime-500',
        },
        {
          label: $t('globe.analysis.legend.altitude.medium'),
          range: '200-1500m',
          color: 'bg-orange-500',
        },
        {
          label: $t('globe.analysis.legend.altitude.high'),
          range: '>1500m',
          color: 'bg-fuchsia-500',
        },
      ],
    }
  }

  return null
})

// Convert photos to markers and apply clustering
const clusteredMarkers = computed(() => {
  const markers = photosToMarkers(filteredPhotosWithLocation.value)
  return clusterMarkers(markers, currentZoom.value)
})

// Separate clusters and single markers
const clusterGroups = computed(() => {
  return clusteredMarkers.value.filter(
    (point) => point.properties.cluster === true,
  )
})

const singleMarkers = computed(() => {
  return clusteredMarkers.value.filter(
    (point) => point.properties.cluster !== true,
  )
})

watch(currentClusterPointId, (newId) => {
  if (newId) {
    router.replace({ query: { ...route.query, photoId: newId } })
  } else {
    const { photoId, ...rest } = route.query
    router.replace({ query: { ...rest } })
  }
})

watch(filteredPhotosWithLocation, (currentPhotos) => {
  if (!currentClusterPointId.value) {
    return
  }

  const exists = currentPhotos.some((photo) => photo.id === currentClusterPointId.value)
  if (!exists) {
    currentClusterPointId.value = null
  }
})

const mapViewState = computed(() => {
  if (photosWithLocation.value.length === 0) {
    return {
      longitude: -122.4,
      latitude: 37.8,
      zoom: 2,
    }
  }

  const latitudes = photosWithLocation.value.map((photo) => photo.latitude!)
  const longitudes = photosWithLocation.value.map((photo) => photo.longitude!)

  const minLat = Math.min(...latitudes)
  const maxLat = Math.max(...latitudes)
  const minLng = Math.min(...longitudes)
  const maxLng = Math.max(...longitudes)

  const centerLat = (minLat + maxLat) / 2
  const centerLng = (minLng + maxLng) / 2

  const latDiff = maxLat - minLat
  const lngDiff = maxLng - minLng
  const maxDiff = Math.max(latDiff, lngDiff)

  let zoom = 8
  if (maxDiff < 0.005) zoom = 16
  else if (maxDiff < 0.02) zoom = 14
  else if (maxDiff < 0.05) zoom = 12
  else if (maxDiff < 0.2) zoom = 10
  else if (maxDiff < 1) zoom = 8
  else if (maxDiff < 5) zoom = 6
  else if (maxDiff < 20) zoom = 5
  else if (maxDiff < 50) zoom = 4
  else zoom = 2

  return {
    longitude: centerLng,
    latitude: centerLat,
    zoom,
  }
})

const onMarkerPinClick = (clusterPoint: any) => {
  // If it's a cluster, zoom to the cluster area
  if (clusterPoint.properties.cluster === true) {
    const clusteredPhotos = clusterPoint.properties.clusteredPhotos || []
    if (clusteredPhotos.length > 0 && mapInstance.value) {
      // Calculate bounds for all photos in the cluster
      const lats = clusteredPhotos.map((p: any) => p.latitude)
      const lngs = clusteredPhotos.map((p: any) => p.longitude)

      const minLat = Math.min(...lats)
      const maxLat = Math.max(...lats)
      const minLng = Math.min(...lngs)
      const maxLng = Math.max(...lngs)

      // Add some padding
      const padding = 0.001

      mapInstance.value.fitBounds(
        [
          [minLng - padding, minLat - padding],
          [maxLng + padding, maxLat + padding],
        ],
        {
          padding: 50,
          duration: 1000,
        },
      )
    }
    return
  }

  // Handle single photo selection
  if (clusterPoint.properties.marker?.id === currentClusterPointId.value) {
    currentClusterPointId.value = null
    return
  }
  currentClusterPointId.value = clusterPoint.properties.marker?.id || null
}

const onMarkerPinClose = () => {
  currentClusterPointId.value = null
}

const onMapLoaded = (map: any) => {
  mapInstance.value = map

  const { photoId } = route.query
  if (photoId && typeof photoId === 'string') {
    const photo = photosWithLocation.value.find((photo) => photo.id === photoId)
    if (photo && photo.latitude && photo.longitude) {
      setTimeout(() => {
        map.flyTo({
          center: [photo.longitude, photo.latitude],
          zoom: 17,
          essential: true,
          duration: 2000,
        })
        setTimeout(() => {
          nextTick(() => {
            currentClusterPointId.value = photoId
          })
        }, 2000)
      }, 600)
    }
  }

  currentZoom.value = map.getZoom()
  if (
    isTimelineFollow.value &&
    isTimelineEnabled.value &&
    (isTimelinePlaying.value || isTimelineDragging.value)
  ) {
    syncTimelineCamera(true)
  }
}

const onMapZoom = useThrottleFn(() => {
  if (!mapInstance.value) return
  currentZoom.value = mapInstance.value.getZoom()
}, 100)

// Map control functions
const zoomIn = () => {
  if (!mapInstance.value) return
  mapInstance.value.zoomIn({ duration: 300 })
}

const zoomOut = () => {
  if (!mapInstance.value) return
  mapInstance.value.zoomOut({ duration: 300 })
}

const resetMap = () => {
  if (!mapInstance.value) return
  // Clear current selection
  currentClusterPointId.value = null

  // Reset to initial view state
  mapInstance.value.flyTo({
    center: [mapViewState.value.longitude, mapViewState.value.latitude],
    zoom: mapViewState.value.zoom,
    essential: true,
    duration: 1000,
  })
}

const generateRandomKey = () => {
  return Math.random().toString(36).substring(2, 15)
}

onBeforeRouteLeave(() => {
  stopTimelineDragging()
  stopTimelinePlayback()
  if (mapInstance.value) {
    mapInstance.value.remove()
    mapInstance.value = null
  }
})

onBeforeUnmount(() => {
  stopTimelineDragging()
  stopTimelinePlayback()
})
</script>

<template>
  <div class="w-full h-svh relative overflow-hidden">
    <GlassButton
      class="absolute top-4 left-4 z-10"
      icon="tabler:home"
      @click="$router.push('/')"
    />

    <div class="absolute top-4 right-4 z-10 flex flex-col items-end">
      <div class="relative">
        <UTooltip
          :text="$t('globe.analysis.annotation')"
          :delay-duration="0"
        >
          <GlassButton
            icon="tabler:adjustments"
            :active="analysisMode !== 'none'"
            @click="parameterAnnotationOpen = !parameterAnnotationOpen"
          />
        </UTooltip>

        <AnimatePresence>
          <motion.div
            v-if="parameterAnnotationOpen"
            :initial="{ opacity: 0, y: -8, scale: 0.96 }"
            :animate="{ opacity: 1, y: 0, scale: 1 }"
            :exit="{ opacity: 0, y: -8, scale: 0.96 }"
            :transition="{ duration: 0.2, ease: 'easeOut' }"
            class="absolute right-0 top-full mt-2 z-40 w-64 origin-top-right overflow-hidden rounded-xl border border-neutral-100 bg-white/30 text-neutral-700 shadow-md shadow-neutral-300/20 backdrop-blur-md dark:border-white/10 dark:bg-neutral-700/30 dark:text-white/80 dark:shadow-black/20"
          >
            <div
              class="px-3 py-2 border-b border-neutral-100/80 dark:border-white/10"
            >
              <div class="flex items-center gap-2 text-sm font-semibold">
                <Icon
                  name="tabler:adjustments-horizontal"
                  class="size-4 text-primary"
                />
                <span>{{ $t('globe.analysis.annotation') }}</span>
              </div>
              <p class="mt-1 text-[11px] text-neutral-600 dark:text-white/60">
                {{ $t('globe.analysis.annotationDescription') }}
              </p>
            </div>

            <div class="p-2.5 space-y-2">
              <button
                v-for="mode in analysisModeOptions"
                :key="mode.value"
                type="button"
                :class="[
                  'w-full px-2.5 py-2 rounded-lg text-left transition-colors border flex items-center gap-2.5',
                  analysisMode === mode.value
                    ? 'bg-primary/90 text-white border-primary/70 shadow-sm'
                    : 'bg-white/15 text-neutral-700 dark:text-white/80 border-neutral-200/70 dark:border-white/10 hover:bg-white/30 dark:hover:bg-black/20',
                ]"
                @click="analysisMode = mode.value"
              >
                <span
                  :class="[
                    'size-7 rounded-md flex items-center justify-center shrink-0 border',
                    analysisMode === mode.value
                      ? 'bg-white/20 border-white/30'
                      : 'bg-white/30 dark:bg-black/20 border-neutral-200/60 dark:border-white/10',
                  ]"
                >
                  <Icon
                    :name="mode.icon"
                    class="size-4"
                  />
                </span>
                <span class="min-w-0">
                  <span class="block text-xs font-semibold leading-none">{{
                    mode.label
                  }}</span>
                  <span
                    class="block text-[10px] mt-1 text-neutral-500 dark:text-white/55"
                  >
                    {{ mode.description }}
                  </span>
                </span>
              </button>
            </div>

            <div
              v-if="analysisLegend"
              class="mx-2.5 mb-2.5 rounded-lg border border-neutral-200/70 dark:border-white/10 bg-white/25 dark:bg-black/20 p-2"
            >
              <div
                class="text-[10px] font-semibold text-neutral-600 dark:text-white/70 px-1 mb-1"
              >
                {{ analysisLegend.title }}
              </div>
              <div
                v-for="item in analysisLegend.items"
                :key="item.label"
                class="flex items-center justify-between gap-2 text-[10px] text-neutral-700 dark:text-white/80 px-1 py-1 rounded-md hover:bg-white/40 dark:hover:bg-black/20"
              >
                <span class="inline-flex items-center gap-1.5 min-w-0">
                  <span
                    :class="[
                      'size-2.5 rounded-full shrink-0 ring-1 ring-black/10 dark:ring-white/20',
                      item.color,
                    ]"
                  />
                  <span class="truncate">{{ item.label }}</span>
                </span>
                <span class="font-mono text-neutral-500 dark:text-white/55">{{
                  item.range
                }}</span>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <div class="mt-2 relative">
        <UTooltip
          :text="$t('globe.timeline.toggle')"
          :delay-duration="0"
        >
          <GlassButton
            icon="tabler:timeline-event"
            :active="isTimelineEnabled"
            @click="toggleTimelineEnabled"
          />
        </UTooltip>
      </div>
    </div>

    <div class="absolute bottom-4 left-4 z-10 flex flex-col">
      <!-- Zoom in -->
      <GlassButton
        class="rounded-b-none border-b-0"
        icon="tabler:plus"
        @click="zoomIn"
      />
      <!-- Zoom out -->
      <GlassButton
        class="rounded-none"
        icon="tabler:minus"
        @click="zoomOut"
      />
      <!-- Reset map -->
      <GlassButton
        class="rounded-t-none border-t-0"
        icon="tabler:scan-position"
        @click="resetMap"
      />
    </div>

    <div
      v-if="isTimelineEnabled"
      class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-[min(92vw,54rem)] max-sm:left-3 max-sm:right-3 max-sm:translate-x-0 max-sm:w-auto max-sm:pl-16"
    >
      <div
        class="rounded-xl border border-neutral-100 bg-white/30 text-neutral-700 shadow-md shadow-neutral-300/20 backdrop-blur-md dark:border-white/10 dark:bg-neutral-700/30 dark:text-white/80 dark:shadow-black/20 px-3 py-2"
      >
        <div class="flex items-center gap-2">
          <UTooltip
            :text="$t('globe.timeline.playPause')"
            :delay-duration="0"
          >
            <GlassButton
              size="sm"
              :icon="isTimelinePlaying ? 'tabler:player-pause' : 'tabler:player-play'"
              :class="
                !hasTimelineData || !isTimelineEnabled
                  ? 'opacity-40 pointer-events-none'
                  : ''
              "
              @click="toggleTimelinePlayback"
            />
          </UTooltip>
          <UTooltip
            :text="$t('globe.timeline.follow')"
            :delay-duration="0"
          >
            <GlassButton
              size="sm"
              icon="tabler:current-location"
              :active="isTimelineFollow"
              :class="!hasTimelineData ? 'opacity-40 pointer-events-none' : ''"
              @click="toggleTimelineFollow"
            />
          </UTooltip>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2 text-[11px]">
              <span class="font-medium">{{ $t('globe.timeline.title') }}</span>
              <span class="text-neutral-600 dark:text-white/60">
                {{ filteredPhotosWithLocation.length }}/{{ photosWithLocation.length }}
              </span>
            </div>
            <div
              ref="timelineTrackRef"
              :class="[
                'mt-2 relative h-5 select-none touch-none',
                hasTimelineData
                  ? 'cursor-pointer'
                  : 'cursor-not-allowed opacity-60',
              ]"
              @pointerdown="onTimelinePointerDown"
            >
              <div
                class="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-neutral-200/80 dark:bg-white/15"
              />
              <div
                class="absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-linear-to-r from-neutral-200/85 via-white/95 to-neutral-200/85 dark:from-white/35 dark:via-white/90 dark:to-white/35 shadow-[0_0_10px_rgba(255,255,255,0.35)]"
                :style="{ width: timelineProgressStyle }"
              />
              <div
                class="absolute top-1/2 -translate-y-1/2 h-3 w-1.5 rounded-sm border border-white/90 bg-white shadow-[0_0_0_1px_rgba(255,255,255,0.45),0_0_10px_rgba(255,255,255,0.55)] dark:border-white/70 dark:bg-white/95 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.2),0_0_8px_rgba(255,255,255,0.45)]"
                :style="{ left: `calc(${timelineProgressStyle} - 0.1875rem)` }"
              />
            </div>
            <div
              class="mt-1 flex items-center justify-between gap-2 text-[10px] text-neutral-500 dark:text-white/55 font-mono"
            >
              <span>{{ timelineStartLabel }}</span>
              <span class="text-neutral-700 dark:text-white/80">{{
                timelineCurrentLabel
              }}</span>
              <span>{{ timelineEndLabel }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <motion.div
      :initial="{ opacity: 0, scale: 1.08 }"
      :animate="{ opacity: 1, scale: 1 }"
      :transition="{ duration: 0.6, delay: 0.1 }"
      class="w-full h-full"
    >
      <ClientOnly>
        <!-- mapbox://styles/hoshinosuzumi/cmev0eujf01dw01pje3g9cmlg -->
        <MapProvider
          class="w-full h-full"
          :map-id="generateRandomKey()"
          :zoom="mapViewState.zoom"
          :center="[mapViewState.longitude, mapViewState.latitude]"
          :attribution-control="false"
          :language="$i18n.locale"
          @load="onMapLoaded"
          @zoom="onMapZoom"
        >
          <!-- Cluster pins -->
          <template v-if="!!mapInstance">
            <MapClusterPin
              v-for="clusterPoint in clusterGroups"
              :key="`cluster-${clusterPoint.properties.marker?.id}`"
              :cluster-point="clusterPoint"
              :marker-id="generateRandomKey()"
              @click="onMarkerPinClick"
              @close="onMarkerPinClose"
            />
          </template>

          <!-- Single photo pins -->
          <template v-if="!!mapInstance">
            <MapPhotoPin
              v-for="clusterPoint in singleMarkers"
              :key="`single-${clusterPoint.properties.marker?.id}`"
              :cluster-point="clusterPoint"
              :is-selected="
                clusterPoint.properties.marker?.id === currentClusterPointId
              "
              :analysis-mode="analysisMode"
              :marker-id="generateRandomKey()"
              @click="onMarkerPinClick"
              @close="onMarkerPinClose"
            />
          </template>
        </MapProvider>

        <template #fallback>
          <div class="w-full h-full flex items-center justify-center">
            <Icon
              name="tabler:map-pin-off"
              class="size-10 text-gray-500 animate-pulse"
            />
          </div>
        </template>
      </ClientOnly>
    </motion.div>
  </div>
</template>

<style>
.mapboxgl-ctrl-logo {
  display: none !important;
}

.mapboxgl-ctrl-attrib {
  display: none !important;
}
</style>
