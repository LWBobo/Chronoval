<script lang="ts" setup>
import { motion } from 'motion-v'
import type { GlobeMapPayload, GlobeMapPhoto } from '~~/shared/types/map'
import { clusterMarkers, photosToMarkers } from '~/utils/clustering'
import {
  buildTimelineModel,
  distanceKm,
  progressForTimelineTimestamp,
  timelinePhotoCountAt,
  timelinePlaceIndexAt,
  timestampForTimelineProgress,
  travelDurationMs,
  type TimelinePlace,
  type TimelineStep,
} from '~/utils/globe-timeline'
import {
  flightPeakZoom,
  liftThenMove,
  waitForMapIdle,
} from '~/utils/mapCameraPreload'
import { setProtomapsFollowMode } from '~/utils/protomapsStyle'

useHead({ title: () => $t('title.globe') })

const route = useRoute()
const router = useRouter()
const dayjs = useDayjs()
const mapId = 'chronoval-globe-map'
const defaultMapView = { longitude: 105, latitude: 35, zoom: 2 }
const { selectedMode, effectiveMode, cycleMode: cycleNetworkMode } =
  useTimelineNetworkMode()
const networkModeLabel = computed(() =>
  $t(`globe.timeline.networkMode.${selectedMode.value}`),
)
const networkModeIcon = computed(() =>
  effectiveMode.value === 'save-data'
    ? 'tabler:antenna-bars-3'
    : 'tabler:antenna-bars-5',
)

const { loggedIn, user } = useUserSession()
const mapViewerKey = computed(() =>
  loggedIn.value
    ? `user:${user.value?.id ?? 'unknown'}:${user.value?.isAdmin ? 'admin' : 'user'}`
    : 'public',
)
const {
  data: mapPayload,
  pending: photosPending,
  refresh: refreshMapPhotos,
} = useLazyFetch<GlobeMapPayload>('/api/map/photos', {
  server: false,
  default: () => ({ photos: [] }),
})

const photosWithLocation = computed<GlobeMapPhoto[]>(
  () => mapPayload.value?.photos ?? [],
)
const datedPhotosWithLocation = computed(() =>
  photosWithLocation.value
    .map((photo) => ({
      photo,
      timestamp: photo.dateTaken
        ? new Date(photo.dateTaken).getTime()
        : Number.NaN,
    }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp || a.photo.id.localeCompare(b.photo.id),
    ),
)
const undatedPhotosWithLocation = computed(() =>
  photosWithLocation.value.filter(
    (photo) =>
      !photo.dateTaken || !Number.isFinite(new Date(photo.dateTaken).getTime()),
  ),
)

type TimelinePlaybackState =
  | 'idle'
  | 'preloading'
  | 'travel'
  | 'dwell'
  | 'paused'
type PlaybackRate = 0.5 | 1 | 2

const timelineProgress = ref(100)
const timelineCurrentTimestamp = ref<number | null>(null)
const timelineVisibleDatedCount = ref(0)
const isTimelineEnabled = ref(false)
const isTimelineDragging = ref(false)
const isTimelineFollow = ref(true)
const timelineTrackRef = ref<HTMLElement | null>(null)
const playbackState = ref<TimelinePlaybackState>('idle')
const playbackRate = ref<PlaybackRate>(1)
const playbackPausedByInteraction = ref(false)
const isTimelinePlaying = computed(() =>
  ['preloading', 'travel', 'dwell'].includes(playbackState.value),
)
const timelineModel = computed(() =>
  buildTimelineModel(datedPhotosWithLocation.value),
)
const timelinePlaces = computed(() => timelineModel.value?.places ?? [])
const hasTimelineData = computed(() => Boolean(timelineModel.value))
const timelineRange = computed(() => {
  const model = timelineModel.value
  return model ? { min: model.minTimestamp, max: model.maxTimestamp } : null
})

let timelineAnimationFrame: number | null = null
let playbackRunId = 0
let resumePlaybackAfterScrub = false
let lastScrubCameraAt = 0
let lastScrubPlaceId: string | null = null

const clampProgress = (value: number) => Math.min(100, Math.max(0, value))

const applyTimelineProgress = (progress: number) => {
  const next = clampProgress(progress)
  timelineProgress.value = next
  const model = timelineModel.value
  if (!model) {
    timelineCurrentTimestamp.value = null
    timelineVisibleDatedCount.value = datedPhotosWithLocation.value.length
    return
  }
  const timestamp = timestampForTimelineProgress(model, next)
  timelineCurrentTimestamp.value = timestamp
  timelineVisibleDatedCount.value = timelinePhotoCountAt(
    datedPhotosWithLocation.value,
    timestamp,
  )
}

watch(
  timelineModel,
  (model) => {
    if (!model) {
      timelineCurrentTimestamp.value = null
      timelineVisibleDatedCount.value = datedPhotosWithLocation.value.length
      return
    }
    applyTimelineProgress(timelineProgress.value)
  },
  { immediate: true },
)

const filteredPhotosWithLocation = computed(() => {
  if (!isTimelineEnabled.value) return photosWithLocation.value
  return [
    ...undatedPhotosWithLocation.value,
    ...datedPhotosWithLocation.value
      .slice(0, timelineVisibleDatedCount.value)
      .map((entry) => entry.photo),
  ]
})

const timelineStartLabel = computed(() =>
  timelineRange.value
    ? dayjs(timelineRange.value.min).format('YYYY-MM-DD')
    : '--',
)
const timelineEndLabel = computed(() =>
  timelineRange.value
    ? dayjs(timelineRange.value.max).format('YYYY-MM-DD')
    : '--',
)
const timelineCurrentLabel = computed(() =>
  timelineCurrentTimestamp.value
    ? dayjs(timelineCurrentTimestamp.value).format('YYYY-MM-DD')
    : '--',
)
const timelineProgressStyle = computed(() => `${timelineProgress.value}%`)

const activeTimelinePlace = computed(() => {
  const model = timelineModel.value
  const timestamp = timelineCurrentTimestamp.value
  if (!isTimelineEnabled.value || !model || timestamp == null) return null
  return model.places[timelinePlaceIndexAt(model.places, timestamp)] ?? null
})

type TimelineMark = {
  id: string
  placeIds: string[]
  progress: number
  timestamp: number
  photoCount: number
  locationLabel: string
  title: string
  titles: string[]
  thumbnailUrl?: string
  exifLine?: string
}

const formatMarkExif = (photo: GlobeMapPhoto) => {
  const parts: string[] = []
  if (photo.focalLength != null) parts.push(`${photo.focalLength}mm`)
  if (photo.cameraModel) parts.push(photo.cameraModel)
  return parts.length ? parts.join(' · ') : undefined
}

const progressForTimestamp = (timestamp: number) => {
  const model = timelineModel.value
  return model ? progressForTimelineTimestamp(model, timestamp) : 100
}

const timelineMarks = computed((): TimelineMark[] => {
  if (!timelineModel.value) return []
  const raw = timelinePlaces.value.map((place) => {
    const first = place.photos[0]!
    const photo = first.photo
    const locationLabel =
      photo.city ||
      photo.locationName ||
      `${photo.latitude.toFixed(2)}, ${photo.longitude.toFixed(2)}`
    const titles = place.photos
      .map((entry) => entry.photo.title)
      .filter((title): title is string => Boolean(title?.trim()))
    return {
      id: place.id,
      placeIds: [place.id],
      progress: progressForTimestamp(first.timestamp),
      timestamp: first.timestamp,
      photoCount: place.photos.length,
      locationLabel,
      title: titles[0] || photo.id,
      titles: titles.slice(0, 3),
      thumbnailUrl: photo.mapThumbnailUrl
        ? `${photo.mapThumbnailUrl}&size=96`
        : photo.thumbnailUrl || undefined,
      exifLine: formatMarkExif(photo),
    }
  })
  if (raw.length <= 80) return raw
  const buckets = new Map<number, TimelineMark[]>()
  for (const mark of raw) {
    const bucket = Math.round(mark.progress / 1.25)
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), mark])
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => {
      const first = group[0]!
      if (group.length === 1) return first
      const titles = group.flatMap((mark) => mark.titles).slice(0, 3)
      return {
        ...first,
        id: `merged-${first.id}`,
        placeIds: group.flatMap((mark) => mark.placeIds),
        photoCount: group.reduce((sum, mark) => sum + mark.photoCount, 0),
        titles,
        title: titles[0] || first.title,
        locationLabel: group
          .map((mark) => mark.locationLabel)
          .filter(Boolean)
          .slice(0, 2)
          .join(' · '),
      }
    })
})

const hoveredMarkId = ref<string | null>(null)
let markHoverHideTimer: ReturnType<typeof setTimeout> | null = null
const hoveredTimelineMark = computed(() =>
  !hoveredMarkId.value || isTimelineDragging.value
    ? null
    : (timelineMarks.value.find((mark) => mark.id === hoveredMarkId.value) ??
      null),
)
const showMarkHover = (markId: string) => {
  if (markHoverHideTimer) clearTimeout(markHoverHideTimer)
  if (!isTimelineDragging.value) hoveredMarkId.value = markId
}
const hideMarkHover = () => {
  if (markHoverHideTimer) clearTimeout(markHoverHideTimer)
  markHoverHideTimer = setTimeout(() => {
    hoveredMarkId.value = null
    markHoverHideTimer = null
  }, 120)
}
const onMarkThumbError = (event: Event) => {
  if (event.target instanceof HTMLImageElement)
    event.target.style.display = 'none'
}

const cancelTimelineRun = (state: TimelinePlaybackState = 'paused') => {
  playbackRunId += 1
  if (timelineAnimationFrame != null)
    cancelAnimationFrame(timelineAnimationFrame)
  timelineAnimationFrame = null
  mapInstance.value?.stop?.()
  playbackState.value = state
}

const animateProgressTo = (
  target: number,
  durationMs: number,
  runId: number,
) => {
  const startProgress = timelineProgress.value
  const started = performance.now()
  return new Promise<boolean>((resolve) => {
    const frame = (now: number) => {
      if (runId !== playbackRunId) return resolve(false)
      const ratio = Math.min(1, (now - started) / Math.max(1, durationMs))
      const eased = ratio * ratio * (3 - 2 * ratio)
      applyTimelineProgress(startProgress + (target - startProgress) * eased)
      if (ratio >= 1) return resolve(true)
      timelineAnimationFrame = requestAnimationFrame(frame)
    }
    timelineAnimationFrame = requestAnimationFrame(frame)
  })
}

const moveCameraToPlace = async (
  place: TimelinePlace<GlobeMapPhoto>,
  durationMs: number,
  runId: number,
  direct = false,
) => {
  const map = mapInstance.value
  if (!map?.getCenter) return true
  const center = map.getCenter()
  const distance = distanceKm(
    center.lat,
    center.lng,
    place.latitude,
    place.longitude,
  )
  if (distance < 0.4) return true
  const targetZoom =
    effectiveMode.value === 'save-data'
      ? Math.min(place.zoom, 9.5)
      : place.zoom
  if (direct) {
    if (effectiveMode.value === 'save-data' && map.jumpTo) {
      map.stop?.()
      map.jumpTo({
        center: [place.longitude, place.latitude],
        zoom: targetZoom,
        essential: true,
        padding: { top: 48, bottom: 140, left: 48, right: 48 },
      })
      await waitForMapIdle(map, 1200)
      return runId === playbackRunId
    }
    map.easeTo({
      center: [place.longitude, place.latitude],
      zoom: targetZoom,
      duration: durationMs,
      essential: true,
      padding: { top: 48, bottom: 140, left: 48, right: 48 },
    })
    await new Promise((resolve) => setTimeout(resolve, durationMs + 50))
    return runId === playbackRunId
  }
  await liftThenMove(map, {
    center: [place.longitude, place.latitude],
    zoom: targetZoom,
    duration: durationMs,
    distanceKm: distance,
    peakZoom:
      effectiveMode.value === 'smooth'
        ? flightPeakZoom(
            distance,
            map.getZoom?.() ?? targetZoom,
            targetZoom,
          )
        : undefined,
    networkMode: effectiveMode.value,
    loadTimeoutMs: effectiveMode.value === 'save-data' ? 2200 : 1000,
    padding: { top: 48, bottom: 140, left: 48, right: 48 },
    shouldContinue: () => runId === playbackRunId && isTimelineFollow.value,
    onPhase: (phase) => {
      if (phase === 'loading') playbackState.value = 'preloading'
      else if (phase !== 'direct') playbackState.value = 'travel'
    },
  })
  return runId === playbackRunId
}

const executeTimelineStep = async (step: TimelineStep, runId: number) => {
  const remaining =
    (step.endProgress - timelineProgress.value) /
    Math.max(0.001, step.endProgress - step.startProgress)
  const duration = Math.max(
    80,
    (step.durationMs * Math.max(0, remaining)) / playbackRate.value,
  )
  if (step.kind === 'dwell') {
    playbackState.value = 'dwell'
    return animateProgressTo(step.endProgress, duration, runId)
  }
  playbackState.value = 'travel'
  const place = timelinePlaces.value[step.placeIndex]
  const progressPromise = animateProgressTo(step.endProgress, duration, runId)
  if (!isTimelineFollow.value || !place) return progressPromise
  const [, progressDone] = await Promise.all([
    moveCameraToPlace(place, duration, runId),
    progressPromise,
  ])
  return progressDone && runId === playbackRunId
}

const runTimelinePlayback = async (runId: number) => {
  const model = timelineModel.value
  if (!model) return
  if (isTimelineFollow.value && timelineProgress.value <= 0.01) {
    const first = model.places[0]
    if (first) {
      playbackState.value = 'preloading'
      const map = mapInstance.value
      const center = map?.getCenter?.()
      const distance = center
        ? distanceKm(center.lat, center.lng, first.latitude, first.longitude)
        : 0
      const ok = await moveCameraToPlace(
        first,
        travelDurationMs(distance, playbackRate.value),
        runId,
      )
      if (!ok) return
    }
  }
  for (const step of model.steps) {
    if (step.endProgress <= timelineProgress.value + 0.001) continue
    if (!(await executeTimelineStep(step, runId))) return
  }
  if (runId === playbackRunId) {
    applyTimelineProgress(100)
    playbackState.value = 'idle'
  }
}

const startTimelinePlayback = () => {
  if (!timelineModel.value) return
  if (timelineProgress.value >= 99.999) applyTimelineProgress(0)
  playbackPausedByInteraction.value = false
  const runId = ++playbackRunId
  void runTimelinePlayback(runId)
}
const stopTimelinePlayback = () => cancelTimelineRun('idle')
const pauseTimelinePlayback = (interaction = false) => {
  playbackPausedByInteraction.value = interaction
  cancelTimelineRun('paused')
}
const toggleTimelinePlayback = () => {
  if (!isTimelineEnabled.value) return
  if (isTimelinePlaying.value) pauseTimelinePlayback(false)
  else startTimelinePlayback()
}
const toggleTimelineEnabled = () => {
  if (isTimelineEnabled.value) {
    stopTimelineDragging()
    stopTimelinePlayback()
    isTimelineEnabled.value = false
    return
  }
  isTimelineEnabled.value = true
  applyTimelineProgress(timelineProgress.value)
}
const cyclePlaybackRate = () => {
  const wasPlaying = isTimelinePlaying.value
  if (wasPlaying) pauseTimelinePlayback(false)
  playbackRate.value =
    playbackRate.value === 0.5 ? 1 : playbackRate.value === 1 ? 2 : 0.5
  if (wasPlaying) startTimelinePlayback()
}

const syncTimelineCamera = async (force = false) => {
  if (!isTimelineFollow.value || !isTimelineEnabled.value) return
  const place = activeTimelinePlace.value
  if (!place) return
  if (!force && place.id === lastScrubPlaceId) return
  lastScrubPlaceId = place.id
  const runId = playbackRunId
  await moveCameraToPlace(place, 520, runId, true)
}

const toggleTimelineFollow = () => {
  if (playbackPausedByInteraction.value && isTimelineFollow.value) {
    playbackPausedByInteraction.value = false
    startTimelinePlayback()
    return
  }
  const wasPlaying = isTimelinePlaying.value
  cancelTimelineRun(wasPlaying ? 'paused' : playbackState.value)
  isTimelineFollow.value = !isTimelineFollow.value
  playbackPausedByInteraction.value = false
  if (wasPlaying) startTimelinePlayback()
  else if (isTimelineFollow.value) void syncTimelineCamera(true)
}

const updateTimelineProgressByClientX = (clientX: number) => {
  const rect = timelineTrackRef.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return
  applyTimelineProgress(((clientX - rect.left) / rect.width) * 100)
}
const scrubCameraThrottled = () => {
  const now = performance.now()
  const place = activeTimelinePlace.value
  if (!isTimelineFollow.value || !place || place.id === lastScrubPlaceId) return
  if (now - lastScrubCameraAt < 120) return
  lastScrubCameraAt = now
  void syncTimelineCamera(true)
}
const stopTimelineDragging = () => {
  isTimelineDragging.value = false
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointermove', onTimelinePointerMove)
    window.removeEventListener('pointerup', onTimelinePointerUp)
  }
}
const onTimelinePointerMove = (event: PointerEvent) => {
  if (!isTimelineDragging.value) return
  updateTimelineProgressByClientX(event.clientX)
  scrubCameraThrottled()
}
const onTimelinePointerUp = async () => {
  stopTimelineDragging()
  await syncTimelineCamera(true)
  if (resumePlaybackAfterScrub) {
    resumePlaybackAfterScrub = false
    startTimelinePlayback()
  }
}
const onTimelinePointerDown = (event: PointerEvent) => {
  if (!isTimelineEnabled.value || !hasTimelineData.value) return
  resumePlaybackAfterScrub = isTimelinePlaying.value
  pauseTimelinePlayback(false)
  hoveredMarkId.value = null
  isTimelineDragging.value = true
  updateTimelineProgressByClientX(event.clientX)
  scrubCameraThrottled()
  window.addEventListener('pointermove', onTimelinePointerMove)
  window.addEventListener('pointerup', onTimelinePointerUp)
}
const onMarkPointerDown = (mark: TimelineMark, event: PointerEvent) => {
  event.stopPropagation()
  if (!isTimelineEnabled.value || !hasTimelineData.value) return
  pauseTimelinePlayback(false)
  applyTimelineProgress(mark.progress)
  hoveredMarkId.value = null
  void syncTimelineCamera(true)
}
const onMarkPointerEnter = (mark: TimelineMark) => showMarkHover(mark.id)
const onMarkPointerLeave = () => hideMarkHover()

const currentClusterPointId = ref<string | null>(null)

// A session change can lower the viewer's collection permissions. Remove the
// old markers before refetching so private photos never remain visible after logout.
watch(mapViewerKey, () => {
  mapPayload.value = { photos: [] }
  currentClusterPointId.value = null
  void refreshMapPhotos({ dedupe: 'cancel' })
})

const mapInstance = ref<any>(null)
const currentZoom = ref<number>(4)
const analysisMode = ref<'none' | 'focalLength' | 'shutterSpeed' | 'altitude'>(
  'none',
)
const parameterAnnotationOpen = ref(false)

const analysisModeOptions = computed(
  () =>
    [
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
    ] as const,
)

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

  const exists = currentPhotos.some(
    (photo) => photo.id === currentClusterPointId.value,
  )
  if (!exists) {
    currentClusterPointId.value = null
  }
})

const mapViewState = computed(() => {
  if (photosWithLocation.value.length === 0) {
    return defaultMapView
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

const syncFollowModeStyle = () => {
  const map = mapInstance.value
  if (!map) return
  const enabled =
    isTimelineFollow.value && isTimelineEnabled.value && isTimelinePlaying.value
  setProtomapsFollowMode(map, enabled)
}

let initialFitDone = false
let routePhotoFocused = false

const focusRoutePhoto = () => {
  const map = mapInstance.value
  const photoId = route.query.photoId
  if (routePhotoFocused || !map || typeof photoId !== 'string') return false
  const photo = photosWithLocation.value.find((item) => item.id === photoId)
  if (!photo) return false
  routePhotoFocused = true
  initialFitDone = true
  map.easeTo({
    center: [photo.longitude, photo.latitude],
    zoom: 17,
    essential: true,
    duration: 900,
  })
  currentClusterPointId.value = photoId
  return true
}

const fitInitialPhotoBounds = () => {
  const map = mapInstance.value
  if (initialFitDone || !map || photosWithLocation.value.length === 0) return
  if (focusRoutePhoto()) return
  initialFitDone = true
  if (photosWithLocation.value.length === 1) {
    const photo = photosWithLocation.value[0]!
    map.easeTo({
      center: [photo.longitude, photo.latitude],
      zoom: 12,
      duration: 650,
    })
    return
  }
  const longitudes = photosWithLocation.value.map((photo) => photo.longitude)
  const latitudes = photosWithLocation.value.map((photo) => photo.latitude)
  map.fitBounds(
    [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ],
    { padding: 72, maxZoom: 12, duration: 750 },
  )
}

const onMapLoaded = (map: any) => {
  mapInstance.value = map
  currentZoom.value = map.getZoom()
  syncFollowModeStyle()
  nextTick(fitInitialPhotoBounds)
  if (
    isTimelineFollow.value &&
    isTimelineEnabled.value &&
    (isTimelinePlaying.value || isTimelineDragging.value)
  ) {
    syncTimelineCamera(true)
  }
}

const onMapUserInteraction = () => {
  if (isTimelinePlaying.value && isTimelineFollow.value) {
    pauseTimelinePlayback(true)
  }
}

const onMapIdle = () => {
  if (mapInstance.value) currentZoom.value = mapInstance.value.getZoom()
}

watch(photosWithLocation, () => nextTick(fitInitialPhotoBounds), {
  flush: 'post',
})

watch([isTimelineFollow, isTimelineEnabled, isTimelinePlaying], () => {
  syncFollowModeStyle()
})

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

const clusterMarkerId = (clusterPoint: any) =>
  `cluster-${(clusterPoint.properties.clusteredPhotos ?? [])
    .map((photo: GlobeMapPhoto) => photo.id)
    .sort()
    .join('-')}`

onMounted(() => {
  // Start server-side archive warmup before MapLibre asks for its first range.
  void $fetch('/api/map/cache/touch', { method: 'POST' }).catch(() => {})
})

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
              :icon="
                isTimelinePlaying ? 'tabler:player-pause' : 'tabler:player-play'
              "
              :class="
                !hasTimelineData || !isTimelineEnabled
                  ? 'opacity-40 pointer-events-none'
                  : ''
              "
              @click="toggleTimelinePlayback"
            />
          </UTooltip>
          <UTooltip
            :text="
              playbackPausedByInteraction
                ? $t('globe.timeline.resumeFollow')
                : $t('globe.timeline.follow')
            "
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
          <UTooltip
            :text="$t('globe.timeline.speed')"
            :delay-duration="0"
          >
            <button
              type="button"
              class="h-8 min-w-10 rounded-lg border border-white/40 bg-white/30 px-2 text-[11px] font-semibold shadow-sm backdrop-blur transition hover:bg-white/50 dark:border-white/15 dark:bg-black/25 dark:hover:bg-black/40"
              @click="cyclePlaybackRate"
            >
              {{ playbackRate }}×
            </button>
          </UTooltip>
          <UTooltip
            :text="$t('globe.timeline.networkMode.help')"
            :delay-duration="0"
          >
            <button
              type="button"
              class="h-8 max-w-28 rounded-lg border border-white/40 bg-white/30 px-2 text-[11px] font-semibold shadow-sm backdrop-blur transition hover:bg-white/50 dark:border-white/15 dark:bg-black/25 dark:hover:bg-black/40 inline-flex items-center gap-1.5"
              @click="cycleNetworkMode"
            >
              <Icon :name="networkModeIcon" class="size-4 shrink-0" />
              <span class="truncate max-sm:hidden">{{ networkModeLabel }}</span>
            </button>
          </UTooltip>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2 text-[11px]">
              <span class="font-medium">{{ $t('globe.timeline.title') }}</span>
              <span class="text-neutral-600 dark:text-white/60">
                <template v-if="photosPending">
                  {{ $t('globe.timeline.loadingPhotos') }}
                </template>
                <template v-else-if="playbackState === 'preloading'">
                  {{ $t('globe.timeline.preparingPlace') }}
                </template>
                <template v-else-if="playbackPausedByInteraction">
                  {{ $t('globe.timeline.pausedByInteraction') }}
                </template>
                <template v-else>
                  {{ filteredPhotosWithLocation.length }}/{{
                    photosWithLocation.length
                  }}
                </template>
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
              <button
                v-for="mark in timelineMarks"
                :key="mark.id"
                type="button"
                class="absolute top-1/2 z-[1] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/80 bg-neutral-500/70 shadow-sm transition-colors hover:bg-neutral-700 dark:border-white/50 dark:bg-white/55 dark:hover:bg-white/90"
                :class="
                  activeTimelinePlace &&
                  mark.placeIds.includes(activeTimelinePlace.id)
                    ? 'bg-neutral-800 dark:bg-white scale-110'
                    : ''
                "
                :style="{ left: `${mark.progress}%` }"
                :aria-label="
                  $t('globe.timeline.markPhotos', { count: mark.photoCount })
                "
                @pointerdown="onMarkPointerDown(mark, $event)"
                @pointerenter="onMarkPointerEnter(mark)"
                @pointerleave="onMarkPointerLeave"
                @focus="onMarkPointerEnter(mark)"
                @blur="onMarkPointerLeave"
              />
              <div
                class="absolute top-1/2 z-[2] -translate-y-1/2 h-3 w-1.5 rounded-sm border border-white/90 bg-white shadow-[0_0_0_1px_rgba(255,255,255,0.45),0_0_10px_rgba(255,255,255,0.55)] dark:border-white/70 dark:bg-white/95 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.2),0_0_8px_rgba(255,255,255,0.45)]"
                :style="{ left: `calc(${timelineProgressStyle} - 0.1875rem)` }"
              />
              <div
                v-if="hoveredTimelineMark"
                class="pointer-events-none absolute bottom-[calc(100%+0.4rem)] z-20 w-max max-w-[16rem] -translate-x-1/2 rounded-lg border border-neutral-200/80 bg-white/95 px-2.5 py-2 text-[11px] text-neutral-700 shadow-lg backdrop-blur-sm dark:border-white/15 dark:bg-neutral-900/95 dark:text-white/85"
                :style="{ left: `${hoveredTimelineMark.progress}%` }"
              >
                <div class="flex gap-2">
                  <img
                    v-if="hoveredTimelineMark.thumbnailUrl"
                    :src="hoveredTimelineMark.thumbnailUrl"
                    alt=""
                    class="h-11 w-11 shrink-0 rounded object-cover bg-neutral-200 dark:bg-white/10"
                    @error="onMarkThumbError"
                  />
                  <div class="min-w-0 space-y-0.5">
                    <div
                      class="font-mono text-[10px] text-neutral-500 dark:text-white/55"
                    >
                      {{
                        dayjs(hoveredTimelineMark.timestamp).format(
                          'YYYY-MM-DD HH:mm',
                        )
                      }}
                    </div>
                    <div
                      v-if="hoveredTimelineMark.locationLabel"
                      class="truncate font-medium"
                    >
                      {{ hoveredTimelineMark.locationLabel }}
                    </div>
                    <div class="truncate text-neutral-600 dark:text-white/70">
                      {{ hoveredTimelineMark.title }}
                    </div>
                    <div class="text-neutral-500 dark:text-white/50">
                      {{
                        $t('globe.timeline.markPhotos', {
                          count: hoveredTimelineMark.photoCount,
                        })
                      }}
                    </div>
                    <div
                      v-if="hoveredTimelineMark.exifLine"
                      class="truncate text-[10px] text-neutral-500 dark:text-white/45"
                    >
                      {{ hoveredTimelineMark.exifLine }}
                    </div>
                  </div>
                </div>
              </div>
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
          :map-id="mapId"
          :zoom="defaultMapView.zoom"
          :center="[defaultMapView.longitude, defaultMapView.latitude]"
          :attribution-control="false"
          :language="$i18n.locale"
          :network-mode="effectiveMode"
          :prefer-lite-map="effectiveMode === 'save-data'"
          @load="onMapLoaded"
          @zoom="onMapZoom"
          @user-interaction="onMapUserInteraction"
          @idle="onMapIdle"
        >
          <!-- Cluster pins -->
          <template v-if="!!mapInstance">
            <MapClusterPin
              v-for="clusterPoint in clusterGroups"
              :key="clusterMarkerId(clusterPoint)"
              :cluster-point="clusterPoint"
              :marker-id="clusterMarkerId(clusterPoint)"
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
              :marker-id="clusterPoint.properties.marker?.id"
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
