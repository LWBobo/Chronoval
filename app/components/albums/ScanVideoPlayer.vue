<script lang="ts" setup>
/**
 * 相簿内嵌视频播放器（自定义 UI）：
 * - 点击画面播放/暂停，双击切换全屏
 * - 底部渐变控制栏：播放/暂停、当前时间、可拖动进度条、音量、全屏
 * - 播放中无操作自动隐藏控制栏，缓冲时显示加载动画
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
const volume = ref(1)
const muted = ref(false)
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
  volume.value = v.volume
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

const onVolumeChange = () => {
  const v = videoEl.value
  if (!v) return
  volume.value = v.volume
  muted.value = v.muted
}

const toggleMute = () => {
  const v = videoEl.value
  if (!v) return
  v.muted = !v.muted
}

const onVolumeInput = (e: Event) => {
  const v = videoEl.value
  if (!v) return
  const val = Number((e.target as HTMLInputElement).value)
  v.volume = val
  v.muted = val === 0
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
  }, 3000)
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
      @volumechange="onVolumeChange"
      @click="togglePlay"
    ></video>

    <!-- 缓冲加载 -->
    <div
      v-if="buffering && !ended"
      class="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <div
        class="size-11 animate-spin rounded-full border-[3px] border-white/25 border-t-white/90"
      />
    </div>

    <!-- 大播放按钮（暂停/未播放时） -->
    <button
      v-if="!isPlaying && !buffering"
      type="button"
      class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/20 transition-opacity"
      @click="togglePlay"
    >
      <span
        class="flex size-16 items-center justify-center rounded-full bg-white/15 text-white shadow-lg ring-1 ring-white/30 backdrop-blur-md transition-transform hover:scale-105"
      >
        <Icon
          :name="ended ? 'tabler:reload' : 'tabler:player-play-filled'"
          class="size-8 ml-1"
        />
      </span>
    </button>

    <!-- 底部控制栏 -->
    <div
      class="absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300"
      :class="showControls || !isPlaying ? 'opacity-100' : 'opacity-0'"
      @pointermove.stop
      @click.stop
    >
      <div class="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/80 to-transparent" />
      <div class="relative flex items-center gap-3 px-4 pb-3">
        <button
          type="button"
          class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
          :aria-label="isPlaying ? $t('albums.scan.video.pause') : $t('albums.scan.video.play')"
          @click="togglePlay"
        >
          <Icon
            :name="isPlaying ? 'tabler:player-pause-filled' : 'tabler:player-play-filled'"
            class="size-6"
          />
        </button>

        <span class="shrink-0 text-xs font-medium tabular-nums text-white/90">
          {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
        </span>

        <!-- 进度条 -->
        <div
          ref="progressEl"
          class="group/progress relative h-8 min-w-0 flex-1 cursor-pointer py-3"
          @pointerdown="onProgressPointerDown"
        >
          <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25">
            <div
              class="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-sky-400 to-violet-400"
              :style="{ width: `${progress * 100}%` }"
            />
          </div>
          <div
            class="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md transition-transform group-hover/progress:scale-125"
            :style="{ left: `${progress * 100}%` }"
          />
        </div>

        <!-- 音量 -->
        <div class="group/vol relative flex shrink-0 items-center">
          <button
            type="button"
            class="flex size-9 cursor-pointer items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
            :aria-label="muted || volume === 0 ? $t('albums.scan.video.unmute') : $t('albums.scan.video.mute')"
            @click="toggleMute"
          >
            <Icon
              :name="muted || volume === 0 ? 'tabler:volume-3' : 'tabler:volume'"
              class="size-6"
            />
          </button>
          <div
            class="absolute bottom-full left-1/2 mb-2 hidden w-24 -translate-x-1/2 rounded-xl bg-black/80 p-2 opacity-0 shadow-lg backdrop-blur-md transition-opacity group-hover/vol:opacity-100 group-hover/vol:block"
          >
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="w-full accent-sky-400"
              :value="muted ? 0 : volume"
              @input="onVolumeInput"
            />
          </div>
        </div>

        <!-- 全屏 -->
        <button
          type="button"
          class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
          :aria-label="isFullscreen ? $t('albums.scan.video.exitFullscreen') : $t('albums.scan.video.fullscreen')"
          @click="toggleFullscreen"
        >
          <Icon
            :name="isFullscreen ? 'tabler:arrows-minimize' : 'tabler:arrows-maximize'"
            class="size-6"
          />
        </button>
      </div>
    </div>
  </div>
</template>
