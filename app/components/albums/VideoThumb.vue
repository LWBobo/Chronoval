<script lang="ts" setup>
import { twMerge } from 'tailwind-merge'
import type { CSSProperties } from 'vue'

/**
 * 视频缩略图（相册卡片专用）
 * - 有服务端缩略图（poster，由 ffmpeg 抽帧生成）时优先展示；
 * - poster 缺失或加载失败时，用隐藏 <video> 抽取浏览器首帧兜底，
 *   保证扫描相簿内的视频卡片永远有图（而非空白占位）。
 * - 抽帧成功即释放视频资源，避免卡片常驻解码器。
 */
const props = withDefaults(
  defineProps<{
    /** 视频文件源（originalUrl）：poster 缺失/失败时用于浏览器抽帧 */
    videoSrc: string
    /** 服务端生成的视频缩略图 URL */
    poster?: string | null
    alt: string
    thumbhash?: string | null
    class?: string
    thumbhashClass?: string
    style?: CSSProperties
    imageContain?: boolean
    threshold?: number | number[]
    rootMargin?: string
    lazy?: boolean
  }>(),
  {
    poster: null,
    thumbhash: null,
    class: '',
    thumbhashClass: '',
    style: undefined,
    imageContain: false,
    threshold: 0.1,
    rootMargin: '50px',
    lazy: true,
  },
)

const emit = defineEmits<{
  load: []
  error: []
}>()

const elemRef = useTemplateRef('elemRef')
const videoRef = useTemplateRef('videoRef')

// 可见性：lazy 时进入视口才挂载 <video> 抽帧
const isElemVisible = ref(false)
// poster（服务端缩略图）加载失败：降级到浏览器抽帧
const posterFailed = ref(false)
// 浏览器抽帧结果（dataURL）
const frameDataUrl = ref<string | null>(null)
// 视频源不可用（无法抽帧）
const videoFailed = ref(false)

const usePoster = computed(() => Boolean(props.poster) && !posterFailed.value)
const isReady = computed(() => Boolean(frameDataUrl.value))

let frameTimer: ReturnType<typeof setTimeout> | null = null
const clearTimer = () => {
  if (frameTimer !== null) {
    clearTimeout(frameTimer)
    frameTimer = null
  }
}
onBeforeUnmount(clearTimer)

/** 触发抽帧：仅当可见、无 poster 可用、尚无结果且视频源有效时 */
const maybeCapture = () => {
  if (!props.videoSrc || usePoster.value || frameDataUrl.value || videoFailed.value)
    return
  if (!isElemVisible.value) return
  clearTimer()
  // 等 <video> 渲染/元数据就绪后再尝试
  frameTimer = setTimeout(tryCapture, 60)
}

/** 就绪则 seek 到代表性帧，否则等待 loadeddata */
const tryCapture = () => {
  const v = videoRef.value
  if (!v) return
  if (v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
    seekAndCapture(v)
  }
  // 元数据未就绪：loadedmetadata/loadeddata 事件会再次触发 tryCapture
}

/** seek 到中前段画面（避免黑屏片头），seeked 后抽帧；seek 不可用/超时则抽当前帧兜底 */
const seekAndCapture = (v: HTMLVideoElement) => {
  clearTimer()
  const duration = v.duration || 0
  const seekTo = duration > 2 ? Math.min(Math.max(duration * 0.1, 0.1), 1) : 0.1
  try {
    v.currentTime = seekTo
    // seeked 迟迟不触发（如网络慢）时兜底抽当前帧
    frameTimer = setTimeout(() => captureFrame(v), 1500)
  } catch {
    captureFrame(v)
  }
}

/** 将当前视频帧绘制到 canvas，转 JPEG dataURL 展示，并释放视频资源 */
const captureFrame = (v: HTMLVideoElement | null) => {
  if (!v || frameDataUrl.value) return
  try {
    const w = v.videoWidth
    const h = v.videoHeight
    if (!w || !h) return
    const scale = Math.min(1, 480 / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0, cw, ch)
    frameDataUrl.value = canvas.toDataURL('image/jpeg', 0.75)
    clearTimer()
    // 抽帧完成：移除 src 释放解码器
    v.removeAttribute('src')
    v.load()
    emit('load')
  } catch {
    // 抽帧失败（罕见，如跨域污染），保留失败占位
  }
}

const onPosterError = () => {
  posterFailed.value = true
  emit('error')
}

const onPosterLoaded = () => {
  emit('load')
}

const onVideoSeeked = () => {
  captureFrame(videoRef.value)
}

const onVideoError = () => {
  videoFailed.value = true
  clearTimer()
  emit('error')
}

onMounted(() => {
  if (!props.lazy) isElemVisible.value = true
})

const { stop } = useIntersectionObserver(
  elemRef,
  ([entry]) => {
    isElemVisible.value = entry?.isIntersecting || false
    if (isElemVisible.value) {
      stop()
      maybeCapture()
    }
  },
  {
    threshold: props.threshold,
    rootMargin: props.rootMargin,
    immediate: props.lazy,
  },
)

// poster 缺失/失败后状态切换：立即尝试抽帧（lazy 未可见时由 IntersectionObserver 兜底）
watch(
  usePoster,
  (p) => {
    if (!p) maybeCapture()
  },
  { immediate: true },
)
</script>

<template>
  <div
    ref="elemRef"
    :class="twMerge('relative overflow-hidden', $props.class)"
    :style="style"
  >
    <!-- 服务端缩略图优先 -->
    <ThumbImage
      v-if="usePoster"
      :src="poster"
      :alt="alt"
      :thumbhash="thumbhash"
      :image-contain="imageContain"
      class="absolute inset-0 h-full w-full"
      :lazy="false"
      @load="onPosterLoaded"
      @error="onPosterError"
    />

    <!-- 浏览器抽帧兜底 -->
    <template v-else>
      <ThumbHash
        v-if="thumbhash && !isReady"
        :thumbhash="thumbhash"
        :class="
          twMerge(
            'thumb-blur-placeholder absolute inset-0 scale-110 blur-md brightness-[0.9] saturate-[0.9]',
            thumbhashClass,
          )
        "
      />
      <div
        v-if="thumbhash && !isReady"
        class="thumb-atmosphere absolute inset-0 pointer-events-none"
      />

      <img
        v-if="isReady && frameDataUrl"
        :src="frameDataUrl"
        :alt="alt"
        :class="
          twMerge(
            'absolute inset-0 w-full h-full',
            imageContain ? 'object-contain' : 'object-cover',
          )
        "
      />
      <div
        v-else-if="videoFailed"
        class="absolute inset-0 flex items-center justify-center bg-neutral-200 dark:bg-neutral-800"
      >
        <Icon name="tabler:video-off" class="size-6 text-neutral-400" />
      </div>

      <!-- 隐藏抽帧源：仅当进入视口且无可用缩略图时挂载 -->
      <video
        v-if="isElemVisible && videoSrc && !videoFailed"
        ref="videoRef"
        class="pointer-events-none absolute size-0 opacity-0"
        :src="videoSrc"
        muted
        playsinline
        preload="metadata"
        @loadedmetadata="tryCapture"
        @loadeddata="tryCapture"
        @seeked="onVideoSeeked"
        @error="onVideoError"
      />
    </template>
  </div>
</template>

<style scoped>
/* 与 ThumbImage 保持一致的模糊占位氛围层（纯色底 + 暗色透明高斯氛围） */
.thumb-atmosphere {
  background-color: rgba(8, 9, 12, 0.35);
}
</style>
