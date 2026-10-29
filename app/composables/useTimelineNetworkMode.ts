import {
  browserNetworkInformation,
  readTimelineNetworkMode,
  resolveTimelineNetworkMode,
  TIMELINE_NETWORK_CHANGE_EVENT,
  TIMELINE_NETWORK_STORAGE_KEY,
  type TimelineNetworkMode,
} from '~/utils/mapNetworkProfile'

export function useTimelineNetworkMode() {
  const selectedMode = useState<TimelineNetworkMode>(
    'timeline-network-mode',
    () => 'auto',
  )
  if (import.meta.client) selectedMode.value = readTimelineNetworkMode()
  const networkRevision = ref(0)
  let connection: ReturnType<typeof browserNetworkInformation> =
    import.meta.client ? browserNetworkInformation() : null

  const refreshNetwork = () => {
    networkRevision.value++
  }

  onMounted(() => {
    connection = browserNetworkInformation()
    connection?.addEventListener('change', refreshNetwork)
    refreshNetwork()
  })

  onBeforeUnmount(() => {
    connection?.removeEventListener('change', refreshNetwork)
  })

  watch(selectedMode, (mode) => {
    if (!import.meta.client) return
    try {
      localStorage.setItem(TIMELINE_NETWORK_STORAGE_KEY, mode)
    } catch {
      // The preference is optional when storage is blocked.
    }
    window.dispatchEvent(
      new CustomEvent(TIMELINE_NETWORK_CHANGE_EVENT, { detail: mode }),
    )
  })

  const effectiveMode = computed(() => {
    void networkRevision.value
    return resolveTimelineNetworkMode(selectedMode.value, connection)
  })

  const cycleMode = () => {
    selectedMode.value =
      selectedMode.value === 'auto'
        ? 'save-data'
        : selectedMode.value === 'save-data'
          ? 'smooth'
          : 'auto'
  }

  return { selectedMode, effectiveMode, cycleMode }
}
