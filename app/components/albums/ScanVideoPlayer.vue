<script lang="ts" setup>
/**
 * 相簿内嵌视频播放器（简约自定义 UI）：
 * - 点击画面播放/暂停，双击全屏
 * - 底部极细白色进度条（可点击/拖动 seek），下方一行最小按钮：播放/暂停 + 时间 + 全屏
 * - 播放中无操作自动隐藏全部控件，缓冲时显示加载动画
 */
const props = withDefaults(
  defineProps<{
    src: string
    poster?: string | null
    /** 是否当前可见 slide（用于切走时自动暂停） */
    active?: boolean
  }>(),
  {
    poster: null,
    active: true,
  },
)

const containerEl = ref<HTMLElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const progressEl = ref<HTMLElement | null>(null)

const isPlaying = ref(false)
const buffering = ref(false)
const ended = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const isFullscreen = ref(false)
const showControls = ref(true)
const isSeeking = ref(false)

const progress = computed(() =>
  duration.value > 0 ? Math.min(currentTime.value / duration.value, 1) : 0,
)

const formatTime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const togglePlay = () => {
  const v = videoEl.value
  if (!v) return
  if (v.paused) void v.play()
  else v.pause()
}

const onLoadedMetadata = () => {
  const v = videoEl.value
  if (!v) return
  duration.value = v.duration || 0
}

const onTimeUpdate = () => {
  const v = videoEl.value
  if (!v) return
  if (!isSeeking.value) currentTime.value = v.currentTime
}

const onPlay = () => {
  isPlaying.value = true
  ended.value = false
  scheduleHide()
}

const onPause = () => {
  isPlaying.value = false
  showControls.value = true
}

const onWaiting = () => {
  buffering.value = true
}

const onCanPlay = () => {
  buffering.value = false
}

const onEnded = () => {
  isPlaying.value = false
  ended.value = true
  showControls.value = true
}

/* ===== 进度条拖动 ===== */
const seekToPointer = (clientX: number) => {
  const bar = progressEl.value
  const v = videoEl.value
  if (!bar || !v || duration.value <= 0) return
  const rect = bar.getBoundingClientRect()
  const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
  const t = ratio * duration.value
  currentTime.value = t
  v.currentTime = t
}

const onProgressPointerDown = (e: PointerEvent) => {
  if (e.button !== 0) return
  isSeeking.value = true
  seekToPointer(e.clientX)
  window.addEventListener('pointermove', onProgressPointerMove)
  window.addEventListener('pointerup', onProgressPointerUp)
  window.addEventListener('pointercancel', onProgressPointerUp)
}

const onProgressPointerMove = (e: PointerEvent) => {
  seekToPointer(e.clientX)
}

const onProgressPointerUp = () => {
  isSeeking.value = false
  window.removeEventListener('pointermove', onProgressPointerMove)
  window.removeEventListener('pointerup', onProgressPointerUp)
  window.removeEventListener('pointercancel', onProgressPointerUp)
  scheduleHide()
}

/* ===== 控制栏自动隐藏 ===== */
let hideTimer: ReturnType<typeof setTimeout> | null = null

const scheduleHide = () => {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (isPlaying.value && !isSeeking.value) showControls.value = false
  }, 2500)
}

const onPointerMove = () => {
  showControls.value = true
  if (isPlaying.value && !isSeeking.value) scheduleHide()
}

const onPointerLeave = () => {
  if (isPlaying.value && !isSeeking.value) showControls.value = false
}

/* ===== 全屏 ===== */
const toggleFullscreen = async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else if (containerEl.value) {
      await containerEl.value.requestFullscreen()
    }
  } catch {
    /* 浏览器拒绝时静默忽略 */
  }
}

const onFullscreenChange = () => {
  isFullscreen.value = Boolean(document.fullscreenElement)
}

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  scheduleHide()
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  if (hideTimer) clearTimeout(hideTimer)
})

/* 切走时自动暂停，避免滑动到其他照片后视频继续出声 */
watch(
  () => props.active,
  (a) => {
    if (!a) videoEl.value?.pause()
  },
)
</script>

<template>
  <div
    ref="containerEl"
    class="relative flex h-full w-full select-none items-center justify-center overflow-hidden bg-black"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @dblclick="toggleFullscreen"
  >
    <video
      ref="videoEl"
      :src="src"
      :poster="poster || undefined"
      class="h-full w-full object-contain"
      playsinline
      preload="metadata"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @play="onPlay"
      @pause="onPause"
      @waiting="onWaiting"
      @canplay="onCanPlay"
      @ended="onEnded"
      @click="togglePlay"
    ></video>

    <!-- 缓冲加载 -->
    <div
      v-if="buffering && !ended"
      class="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <div class="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
    </div>

    <!-- 底部控件：极细进度条 + 最小按钮行，播放中自动隐藏 -->
    <div
      class="absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300"
      :class="showControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'"
      @pointermove.stop
      @click.stop
    >
      <!-- 细进度条 -->
      <div
        ref="progressEl"
        class="group/progress relative h-[3px] w-full cursor-pointer transition-[height] duration-150 hover:h-[5px]"
        @pointerdown="onProgressPointerDown"
      >
        <div class="absolute inset-0 bg-white/15">
          <div
            class="absolute inset-y-0 left-0 bg-white/90"
            :style="{ width: `${progress * 100}%` }"
          />
        </div>
        <div
          class="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 transition-opacity group-hover/progress:opacity-100"
          :style="{ left: `${progress * 100}%` }"
        />
      </div>

      <!-- 按钮行 -->
      <div class="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-colors hover:bg-white/10"
          :aria-label="isPlaying ? $t('albums.scan.video.pause') : $t('albums.scan.video.play')"
          @click="togglePlay"
        >
          <Icon
            :name="isPlaying ? 'tabler:player-pause-filled' : 'tabler:player-play-filled'"
            class="size-5"
          />
        </button>

        <span class="shrink-0 text-[11px] font-medium tabular-nums text-white/70">
          {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
        </span>

        <div class="min-w-0 flex-1" />

        <button
          type="button"
          class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10"
          :aria-label="isFullscreen ? $t('albums.scan.video.exitFullscreen') : $t('albums.scan.video.fullscreen')"
          @click="toggleFullscreen"
        >
          <Icon
            :name="isFullscreen ? 'tabler:arrows-minimize' : 'tabler:arrows-maximize'"
            class="size-4.5"
          />
        </button>
      </div>
    </div>
  </div>
</template>
