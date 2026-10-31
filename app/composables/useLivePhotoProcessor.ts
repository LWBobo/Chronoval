import { computed, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import { LivePhotoLoader } from '../libs/live-photo-loader'

const revision = shallowRef(0)
const loader = new LivePhotoLoader({
  onChange: () => {
    revision.value++
  },
})
export const livePhotoCacheEpoch = shallowRef(0)

export function clearLivePhotoCache() {
  loader.clear()
  livePhotoCacheEpoch.value++
}

export const useLivePhotoProcessor = () => {
  const processedLivePhotos = computed(() => {
    void revision.value
    return loader.states()
  })
  const convertMovToMp4 = (url: string, id: string) => loader.load(url, id)
  const scheduleBackgroundLivePhoto = (
    url: string,
    id: string,
    shouldRun?: () => boolean,
  ) => loader.load(url, id, true, shouldRun)
  const getProcessingState = (id: MaybeRefOrGetter<string>) =>
    computed(() => {
      void revision.value
      return loader.getState(toValue(id))
    })
  const preloadLivePhotosInViewport = async (
    photos: Array<{
      id: string
      livePhotoVideoUrl?: string | null
      isVisible?: boolean
    }>,
  ) => {
    for (const photo of photos.filter(
      (item) => item.isVisible !== false && item.livePhotoVideoUrl,
    )) {
      await scheduleBackgroundLivePhoto(photo.livePhotoVideoUrl!, photo.id)
    }
  }
  return {
    convertMovToMp4,
    scheduleBackgroundLivePhoto,
    getProcessingState,
    preloadLivePhotosInViewport,
    batchProcessLivePhotos: preloadLivePhotosInViewport,
    cleanupExpiredCache: () => loader.prune(),
    clearProcessedCache: clearLivePhotoCache,
    processedLivePhotos,
    getCacheStats: () => {
      const states = [...loader.states().values()]
      return {
        total: states.length,
        processed: states.filter((state) => state.mp4Blob).length,
        processing: states.filter((state) => state.isProcessing).length,
        failed: states.filter((state) => state.error).length,
        totalSizeMB:
          Math.round(
            (states.reduce(
              (sum, state) => sum + (state.mp4Blob?.size || 0),
              0,
            ) /
              1024 /
              1024) *
              100,
          ) / 100,
      }
    },
  }
}

/** 保留旧版的省流策略：慢网与省流模式仅在用户要求播放时下载。 */
export function canPrefetchLivePhoto(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string }
    }
  ).connection
  return (
    !connection?.saveData &&
    !['slow-2g', '2g', '3g'].includes(connection?.effectiveType || '')
  )
}
