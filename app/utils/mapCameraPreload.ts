/** Timeline camera moves built from native MapLibre/Mapbox easeTo calls. */

import type { ResolvedTimelineNetworkMode } from '~/utils/mapNetworkProfile'

export type CameraPhase =
  | 'lift'
  | 'cruise'
  | 'jump'
  | 'loading'
  | 'descend'
  | 'direct'

export type LiftMoveOptions = {
  center: [number, number] | { lng: number; lat: number }
  zoom?: number
  bearing?: number
  pitch?: number
  duration?: number
  padding?: unknown
  essential?: boolean
  distanceKm?: number
  peakZoom?: number
  networkMode?: ResolvedTimelineNetworkMode
  loadTimeoutMs?: number
  shouldContinue?: () => boolean
  onPhase?: (phase: CameraPhase, durationMs: number) => void
}

function toLngLat(center: [number, number] | { lng: number; lat: number }): {
  lng: number
  lat: number
} {
  if (Array.isArray(center)) return { lng: center[0]!, lat: center[1]! }
  return center
}

export function flightPeakZoom(
  distanceKm: number,
  currentZoom: number,
  targetZoom: number,
): number {
  const base = Math.min(currentZoom, targetZoom)
  const km = Math.max(0, distanceKm)
  const cruise = 6.5 + 5.05 * Math.exp(-km / 230)
  const floor = 6.5
  const maxPeak = base - 0.25
  if (maxPeak <= floor) return Math.min(base, Math.max(floor, base - 0.12))
  return Math.min(maxPeak, Math.max(floor, cruise))
}

function waitForMoveEnd(map: any, durationMs: number) {
  return new Promise<void>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      map.off?.('moveend', finish)
      resolve()
    }
    map.once?.('moveend', finish)
    timer = setTimeout(finish, Math.max(250, durationMs + 350))
  })
}

export function waitForMapIdle(map: any, timeoutMs = 1800) {
  return new Promise<void>((resolve) => {
    let done = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let minimumWait: ReturnType<typeof setTimeout> | undefined
    let tileCheck: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (done) return
      done = true
      if (timeout) clearTimeout(timeout)
      if (minimumWait) clearTimeout(minimumWait)
      if (tileCheck) clearTimeout(tileCheck)
      map.off?.('idle', onIdle)
      resolve()
    }
    const onIdle = () => {
      minimumWait = setTimeout(finish, 120)
    }

    map.once?.('idle', onIdle)
    tileCheck = setTimeout(() => {
      if (map.areTilesLoaded?.()) onIdle()
    }, 80)
    timeout = setTimeout(finish, Math.max(300, timeoutMs))
  })
}

async function easeStep(
  map: any,
  options: Record<string, unknown>,
  durationMs: number,
  shouldContinue?: () => boolean,
) {
  if (shouldContinue && !shouldContinue()) return false
  const waiting = waitForMoveEnd(map, durationMs)
  map.easeTo?.({
    ...options,
    duration: durationMs,
    easing: (t: number) => t * t * (3 - 2 * t),
  })
  await waiting
  return !shouldContinue || shouldContinue()
}

/**
 * Move in three native phases: rise in place, cruise at a low zoom, then
 * descend at the destination. Native easing lets the renderer reuse tiles and
 * avoids a JavaScript jumpTo call on every animation frame.
 */
export async function liftThenMove(map: any, options: LiftMoveOptions) {
  if (!map?.getCenter || !map?.getZoom || !map?.easeTo) return

  const start = map.getCenter()
  const startZoom = map.getZoom()
  const endCenter = toLngLat(options.center)
  const endZoom = options.zoom ?? startZoom
  const endBearing = options.bearing ?? map.getBearing?.() ?? 0
  const endPitch = options.pitch ?? map.getPitch?.() ?? 0
  const networkMode = options.networkMode ?? 'smooth'
  const distance = options.distanceKm ?? 0
  const saveDataPeak =
    distance >= 2500
      ? 2.5
      : distance >= 1000
        ? 3.25
        : distance >= 300
          ? 4
          : distance >= 80
            ? 5
            : 6
  const peakZoom =
    options.peakZoom ??
    (networkMode === 'save-data'
      ? Math.min(startZoom, endZoom, saveDataPeak)
      : flightPeakZoom(distance, startZoom, endZoom))
  const total = Math.max(900, options.duration ?? 2800)
  const liftMs = Math.max(
    240,
    Math.round(total * (networkMode === 'save-data' ? 0.32 : 0.24)),
  )
  const cruiseMs =
    networkMode === 'save-data' ? 0 : Math.max(360, Math.round(total * 0.46))
  const descendMs = Math.max(300, total - liftMs - cruiseMs)
  const common = {
    essential: options.essential ?? true,
    padding: options.padding,
  }

  options.onPhase?.('lift', liftMs)
  if (
    !(await easeStep(
      map,
      { ...common, center: [start.lng, start.lat], zoom: peakZoom },
      liftMs,
      options.shouldContinue,
    ))
  )
    return

  if (networkMode === 'save-data' && map.jumpTo) {
    if (options.shouldContinue && !options.shouldContinue()) return
    options.onPhase?.('jump', 0)
    map.stop?.()
    map.jumpTo({
      ...common,
      center: [endCenter.lng, endCenter.lat],
      zoom: peakZoom,
      bearing: endBearing,
      pitch: 0,
    })
    options.onPhase?.('loading', options.loadTimeoutMs ?? 1800)
    await waitForMapIdle(map, options.loadTimeoutMs ?? 1800)
    if (options.shouldContinue && !options.shouldContinue()) return

    options.onPhase?.('descend', descendMs)
    await easeStep(
      map,
      {
        ...common,
        center: [endCenter.lng, endCenter.lat],
        zoom: endZoom,
        bearing: endBearing,
        pitch: endPitch,
      },
      descendMs,
      options.shouldContinue,
    )
    return
  }

  options.onPhase?.('cruise', cruiseMs)
  if (
    !(await easeStep(
      map,
      {
        ...common,
        center: [endCenter.lng, endCenter.lat],
        zoom: peakZoom,
        bearing: endBearing,
        pitch: Math.min(endPitch, 20),
      },
      cruiseMs,
      options.shouldContinue,
    ))
  )
    return

  options.onPhase?.('descend', descendMs)
  await easeStep(
    map,
    {
      ...common,
      center: [endCenter.lng, endCenter.lat],
      zoom: endZoom,
      bearing: endBearing,
      pitch: endPitch,
    },
    descendMs,
    options.shouldContinue,
  )
}
