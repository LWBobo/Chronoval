export const PLACE_RADIUS_KM = 30
export const PLACE_MAX_TIME_GAP_MS = 7 * 24 * 60 * 60 * 1000

export type TimelinePhotoLike = {
  id: string
  latitude: number
  longitude: number
}

export type DatedTimelinePhoto<
  T extends TimelinePhotoLike = TimelinePhotoLike,
> = {
  photo: T
  timestamp: number
}

export type TimelinePlace<T extends TimelinePhotoLike = TimelinePhotoLike> = {
  id: string
  index: number
  photos: DatedTimelinePhoto<T>[]
  latitude: number
  longitude: number
  zoom: number
}

export type TimelineStep = {
  kind: 'travel' | 'dwell'
  placeIndex: number
  startProgress: number
  endProgress: number
  startTimestamp: number
  endTimestamp: number
  durationMs: number
  distanceKm: number
}

export type TimelineModel<T extends TimelinePhotoLike = TimelinePhotoLike> = {
  places: TimelinePlace<T>[]
  steps: TimelineStep[]
  minTimestamp: number
  maxTimestamp: number
  durationMs: number
}

export function distanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) {
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

export function frameForTimelinePhotos<T extends TimelinePhotoLike>(
  photos: DatedTimelinePhoto<T>[],
) {
  const latitudes = photos.map((entry) => entry.photo.latitude)
  const longitudes = photos.map((entry) => entry.photo.longitude)
  const minLat = Math.min(...latitudes)
  const maxLat = Math.max(...latitudes)
  const minLng = Math.min(...longitudes)
  const maxLng = Math.max(...longitudes)
  const maxDiff = Math.max(maxLat - minLat, maxLng - minLng)
  let zoom = 12
  if (maxDiff < 0.02) zoom = 12.5
  else if (maxDiff < 0.08) zoom = 11.5
  else if (maxDiff < 0.25) zoom = 10
  else if (maxDiff < 0.8) zoom = 8.5
  else zoom = 7
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    zoom,
  }
}

export function groupTimelinePlaces<T extends TimelinePhotoLike>(
  entries: DatedTimelinePhoto<T>[],
  options: { radiusKm?: number; maxTimeGapMs?: number } = {},
): TimelinePlace<T>[] {
  const radiusKm = options.radiusKm ?? PLACE_RADIUS_KM
  const maxTimeGapMs = options.maxTimeGapMs ?? PLACE_MAX_TIME_GAP_MS
  const places: TimelinePlace<T>[] = []

  for (const entry of entries) {
    const current = places[places.length - 1]
    const previous = current?.photos[current.photos.length - 1]
    const anchor = current?.photos[0]
    const samePlace =
      current &&
      previous &&
      anchor &&
      entry.timestamp - previous.timestamp <= maxTimeGapMs &&
      distanceKm(
        anchor.photo.latitude,
        anchor.photo.longitude,
        entry.photo.latitude,
        entry.photo.longitude,
      ) <= radiusKm

    if (samePlace) {
      current.photos.push(entry)
      const frame = frameForTimelinePhotos(current.photos)
      Object.assign(current, frame)
      continue
    }

    const frame = frameForTimelinePhotos([entry])
    places.push({
      id: entry.photo.id,
      index: places.length,
      photos: [entry],
      ...frame,
    })
  }

  return places
}

export function travelDurationMs(distance: number, rate = 1) {
  const raw = Math.min(
    3400,
    Math.max(1600, 1400 + Math.sqrt(Math.max(0, distance)) * 75),
  )
  return Math.round(raw / Math.max(0.1, rate))
}

export function dwellDurationMs(photoCount: number, rate = 1) {
  const raw = Math.min(
    1800,
    Math.max(900, 900 + Math.min(Math.max(0, photoCount - 1), 6) * 120),
  )
  return Math.round(raw / Math.max(0.1, rate))
}

export function buildTimelineModel<T extends TimelinePhotoLike>(
  entries: DatedTimelinePhoto<T>[],
  rate = 1,
): TimelineModel<T> | null {
  if (entries.length < 2) return null
  const places = groupTimelinePlaces(entries)
  const weighted: Omit<TimelineStep, 'startProgress' | 'endProgress'>[] = []

  for (const place of places) {
    const previous = places[place.index - 1]
    if (previous) {
      const distance = distanceKm(
        previous.latitude,
        previous.longitude,
        place.latitude,
        place.longitude,
      )
      weighted.push({
        kind: 'travel',
        placeIndex: place.index,
        startTimestamp: previous.photos[previous.photos.length - 1]!.timestamp,
        endTimestamp: place.photos[0]!.timestamp,
        durationMs: travelDurationMs(distance, rate),
        distanceKm: distance,
      })
    }

    weighted.push({
      kind: 'dwell',
      placeIndex: place.index,
      startTimestamp: place.photos[0]!.timestamp,
      endTimestamp: place.photos[place.photos.length - 1]!.timestamp,
      durationMs: dwellDurationMs(place.photos.length, rate),
      distanceKm: 0,
    })
  }

  const durationMs = weighted.reduce((sum, step) => sum + step.durationMs, 0)
  let elapsed = 0
  const steps = weighted.map((step, index): TimelineStep => {
    const startProgress = durationMs > 0 ? (elapsed / durationMs) * 100 : 0
    elapsed += step.durationMs
    return {
      ...step,
      startProgress,
      endProgress:
        index === weighted.length - 1 || durationMs <= 0
          ? 100
          : (elapsed / durationMs) * 100,
    }
  })

  return {
    places,
    steps,
    minTimestamp: entries[0]!.timestamp,
    maxTimestamp: entries[entries.length - 1]!.timestamp,
    durationMs,
  }
}

function interpolate(a: number, b: number, ratio: number) {
  return a + (b - a) * Math.min(1, Math.max(0, ratio))
}

export function timestampForTimelineProgress(
  model: TimelineModel,
  progress: number,
) {
  const clamped = Math.min(100, Math.max(0, progress))
  const step =
    model.steps.find((item) => clamped <= item.endProgress) ??
    model.steps[model.steps.length - 1]
  if (!step) return model.maxTimestamp
  const span = step.endProgress - step.startProgress
  const ratio = span > 0 ? (clamped - step.startProgress) / span : 1
  return Math.round(interpolate(step.startTimestamp, step.endTimestamp, ratio))
}

export function progressForTimelineTimestamp(
  model: TimelineModel,
  timestamp: number,
) {
  if (timestamp <= model.minTimestamp) return 0
  if (timestamp >= model.maxTimestamp) return 100
  const step =
    model.steps.find(
      (item) =>
        timestamp >= item.startTimestamp && timestamp <= item.endTimestamp,
    ) ?? model.steps.find((item) => timestamp < item.startTimestamp)
  if (!step) return 100
  const span = step.endTimestamp - step.startTimestamp
  const ratio = span > 0 ? (timestamp - step.startTimestamp) / span : 1
  return interpolate(step.startProgress, step.endProgress, ratio)
}

export function timelinePhotoCountAt(
  entries: { timestamp: number }[],
  timestamp: number,
) {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (entries[middle]!.timestamp <= timestamp) low = middle + 1
    else high = middle
  }
  return low
}

export function timelinePlaceIndexAt(
  places: TimelinePlace[],
  timestamp: number,
) {
  let low = 0
  let high = places.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (places[middle]!.photos[0]!.timestamp <= timestamp) low = middle + 1
    else high = middle
  }
  return Math.max(0, low - 1)
}
