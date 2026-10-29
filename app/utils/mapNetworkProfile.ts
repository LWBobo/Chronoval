export type TimelineNetworkMode = 'auto' | 'save-data' | 'smooth'
export type ResolvedTimelineNetworkMode = Exclude<TimelineNetworkMode, 'auto'>

export const TIMELINE_NETWORK_STORAGE_KEY = 'chronoval:timeline-network-mode'
export const TIMELINE_NETWORK_CHANGE_EVENT = 'chronoval:timeline-network-mode'

export type BrowserNetworkInformation = EventTarget & {
  saveData?: boolean
  effectiveType?: string
  downlink?: number
  rtt?: number
}

export function browserNetworkInformation(): BrowserNetworkInformation | null {
  if (typeof navigator === 'undefined') return null
  return (
    (navigator as Navigator & {
      connection?: BrowserNetworkInformation
      mozConnection?: BrowserNetworkInformation
      webkitConnection?: BrowserNetworkInformation
    }).connection ||
    (navigator as Navigator & { mozConnection?: BrowserNetworkInformation })
      .mozConnection ||
    (navigator as Navigator & { webkitConnection?: BrowserNetworkInformation })
      .webkitConnection ||
    null
  )
}

export function readTimelineNetworkMode(): TimelineNetworkMode {
  if (typeof localStorage === 'undefined') return 'auto'
  try {
    const value = localStorage.getItem(TIMELINE_NETWORK_STORAGE_KEY)
    return value === 'save-data' || value === 'smooth' ? value : 'auto'
  } catch {
    return 'auto'
  }
}

export function resolveTimelineNetworkMode(
  selected: TimelineNetworkMode,
  connection = browserNetworkInformation(),
): ResolvedTimelineNetworkMode {
  if (selected !== 'auto') return selected
  if (!connection) return 'save-data'

  const slowType = ['slow-2g', '2g', '3g'].includes(
    connection.effectiveType || '',
  )
  const constrainedDownlink =
    typeof connection.downlink === 'number' && connection.downlink < 8
  const highLatency = typeof connection.rtt === 'number' && connection.rtt > 180
  return connection.saveData || slowType || constrainedDownlink || highLatency
    ? 'save-data'
    : 'smooth'
}

export function mapParallelRequestLimit(
  mode: ResolvedTimelineNetworkMode,
): number {
  return mode === 'save-data' ? 8 : 16
}
