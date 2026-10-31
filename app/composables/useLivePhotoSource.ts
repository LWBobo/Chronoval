import {
  computed,
  ref,
  watch,
  onScopeDispose,
  toValue,
  type MaybeRefOrGetter,
} from 'vue'
import {
  useLivePhotoProcessor,
  livePhotoCacheEpoch,
} from './useLivePhotoProcessor'

interface LivePhotoInput {
  id: string
  isLivePhoto?: number | boolean
  livePhotoVideoUrl?: string | null
}

/** 每个播放器独享 Blob URL；下载缓存共享，切图、关闭与身份变化均使旧结果失效。 */
export function useLivePhotoSource(
  photo: MaybeRefOrGetter<LivePhotoInput | undefined>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const src = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const { convertMovToMp4, scheduleBackgroundLivePhoto, getProcessingState } =
    useLivePhotoProcessor()
  const downloadState = getProcessingState(() => toValue(photo)?.id || '')
  const processingState = computed(() => {
    const state = downloadState.value
    if (!state && !error.value) return null
    return {
      ...(state ?? {
        isProcessing: false,
        progress: 0,
        mp4Blob: null,
        lastProcessed: 0,
        error: null,
      }),
      error: error.value || state?.error || null,
    }
  })
  let sequence = 0
  let disposed = false
  let pending: Promise<string | null> | null = null

  const reset = () => {
    sequence++
    pending = null
    loading.value = false
    error.value = null
    if (src.value) URL.revokeObjectURL(src.value)
    src.value = null
  }
  const load = (background = false): Promise<string | null> => {
    const current = toValue(photo)
    if (
      disposed ||
      !toValue(enabled) ||
      !current?.isLivePhoto ||
      !current.livePhotoVideoUrl
    )
      return Promise.resolve(null)
    if (src.value) {
      error.value = null
      return Promise.resolve(src.value)
    }
    if (pending) {
      if (!background)
        void convertMovToMp4(current.livePhotoVideoUrl, current.id)
      return pending
    }
    const run = ++sequence
    loading.value = true
    error.value = null
    const request = background
      ? scheduleBackgroundLivePhoto(
          current.livePhotoVideoUrl,
          current.id,
          () => !disposed && run === sequence && toValue(enabled),
        )
      : convertMovToMp4(current.livePhotoVideoUrl, current.id)
    pending = request
      .then((blob) => {
        if (disposed || run !== sequence || !toValue(enabled)) return null
        if (!blob) {
          error.value = processingState.value?.error || '动态照片加载失败'
          return null
        }
        src.value = URL.createObjectURL(blob)
        return src.value
      })
      .catch((reason: unknown) => {
        if (run === sequence)
          error.value =
            reason instanceof Error ? reason.message : '动态照片加载失败'
        return null
      })
      .finally(() => {
        if (run === sequence) {
          loading.value = false
          pending = null
        }
      })
    return pending
  }
  watch(
    [
      () => toValue(photo)?.id,
      () => toValue(photo)?.livePhotoVideoUrl,
      () => toValue(enabled),
      livePhotoCacheEpoch,
    ],
    reset,
    { flush: 'sync' },
  )
  onScopeDispose(() => {
    disposed = true
    reset()
  })
  const onError = (event: Event) => {
    const video = event.target as HTMLVideoElement | null
    if (video?.currentSrc && video.currentSrc !== src.value) return
    error.value =
      video?.error?.code === 4
        ? '当前浏览器无法解码此动态视频，已保留静态照片'
        : '动态照片播放失败，已保留静态照片，可重新尝试播放'
  }
  return { src, loading, error, processingState, load, reset, onError }
}
