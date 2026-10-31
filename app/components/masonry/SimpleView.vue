<script lang="ts" setup>
/**
 * 相簿内的简洁看图：沿用当前照片列表与顺序，支持视频、翻页和退出。
 */
interface SimplePhoto {
  id: string
  originalUrl?: string | null
  thumbnailUrl?: string | null
  title?: string | null
  type?: string
}
const props = defineProps<{
  photos: SimplePhoto[]
  backLabel?: string
}>()
const emit = defineEmits<{ back: [] }>()
const list = computed(() => props.photos)
const scrollLocked = useScrollLock(import.meta.client ? document.body : null)
onMounted(() => {
  scrollLocked.value = true
})

const index = ref(0)
const total = computed(() => list.value.length)
const current = computed(() => list.value[index.value])

const next = () => {
  if (index.value < total.value - 1) index.value++
}
const prev = () => {
  if (index.value > 0) index.value--
}

const srcOf = (p?: SimplePhoto | null) =>
  (p?.originalUrl || p?.thumbnailUrl || '') as string
// 扫描库目录照片可能含视频（type='video'）：用 <video> 播放而不是 <img>
const isVideo = (p?: SimplePhoto | null) => p?.type === 'video'

// 预加载下一张全尺寸图：点击"下一张"时无需等待网络（视频不预载）
watch(
  current,
  () => {
    const nextPhoto = list.value[index.value + 1]
    if (isVideo(nextPhoto)) return
    const url = srcOf(nextPhoto)
    if (url && import.meta.client) {
      const img = new Image()
      img.src = url
    }
  },
  { immediate: true },
)

// 键盘导航：← / → 翻页，Esc 返回瀑布流
const onKeydown = (e: KeyboardEvent) => {
  if (
    e.target instanceof HTMLElement &&
    e.target.closest('input, textarea, select, [contenteditable="true"]')
  )
    return
  if (
    e.key !== 'Escape' &&
    e.target instanceof HTMLElement &&
    e.target.closest('video')
  )
    return
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'd') {
    e.preventDefault()
    next()
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'a') {
    e.preventDefault()
    prev()
  } else if (e.key === 'Escape') {
    emit('back')
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// 移动端左右滑动翻页
let touchStartX = 0
let touchStartY = 0
let touchNavigation = false
const onTouchStart = (e: TouchEvent) => {
  touchNavigation = !(
    e.target instanceof HTMLElement && e.target.closest('video, button')
  )
  touchStartX = e.touches[0]?.clientX ?? 0
  touchStartY = e.touches[0]?.clientY ?? 0
}
const onTouchEnd = (e: TouchEvent) => {
  if (!touchNavigation) return
  touchNavigation = false
  const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX
  const dy = (e.changedTouches[0]?.clientY ?? 0) - touchStartY
  // 水平位移明显大于垂直位移才判定为翻页滑动，避免与页面滚动冲突
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) next()
    else prev()
  }
}

// 数据池变化（分片补齐/刷新）时兜底：当前索引越界则退到最后一张
watch(total, (n) => {
  if (index.value >= n) index.value = Math.max(0, n - 1)
})
</script>

<template>
  <div
    class="fixed inset-0 z-[120] flex touch-pan-y flex-col bg-black/95 select-none"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
  >
    <!-- 顶栏：进度计数 + 退出 -->
    <div class="flex items-center justify-between px-4 pt-3 sm:px-6">
      <span class="text-sm tabular-nums text-white/70">
        {{ total ? index + 1 : 0 }} / {{ total }}
      </span>
      <button
        type="button"
        class="flex size-9 cursor-pointer items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        :title="backLabel || $t('gallery.browse.backToMasonry')"
        :aria-label="backLabel || $t('gallery.browse.backToMasonry')"
        @click="emit('back')"
      >
        <Icon
          name="tabler:x"
          class="size-5"
        />
      </button>
    </div>

    <!-- 照片区：单张居中；左右半区点击翻页（桌面悬停显示方向光标） -->
    <div
      class="relative flex min-h-0 flex-1 items-center justify-center p-3 sm:p-6"
    >
      <Transition
        enter-active-class="transition-opacity duration-150"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-100"
        leave-to-class="opacity-0"
        mode="out-in"
      >
        <video
          v-if="current && isVideo(current)"
          :key="current.id"
          :src="srcOf(current)"
          controls
          playsinline
          class="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        />
        <img
          v-else-if="current"
          :key="current.id"
          :src="srcOf(current)"
          :alt="current.title || ''"
          class="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          draggable="false"
        />
      </Transition>

      <!-- 左右热区：整片半区点击翻页，配合方向光标提示 -->
      <button
        type="button"
        v-if="index > 0 && !isVideo(current)"
        class="absolute inset-y-0 left-0 w-[22%] cursor-w-resize"
        :aria-label="$t('gallery.browse.prev')"
        @click="prev"
      />
      <button
        type="button"
        v-if="index < total - 1 && !isVideo(current)"
        class="absolute inset-y-0 right-0 w-[22%] cursor-e-resize"
        :aria-label="$t('gallery.browse.next')"
        @click="next"
      />
    </div>

    <!-- 底部操作：上一张（弱化） / 下一张（主操作） -->
    <div class="flex items-center justify-center gap-3 pb-6 sm:gap-4 sm:pb-8">
      <button
        type="button"
        class="flex h-11 cursor-pointer items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 text-sm text-white/70 backdrop-blur transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
        :disabled="index <= 0"
        @click="prev"
      >
        <Icon
          name="tabler:arrow-left"
          class="size-4"
        />
        <span>{{ $t('gallery.browse.prev') }}</span>
      </button>
      <button
        type="button"
        class="flex h-11 cursor-pointer items-center gap-1.5 rounded-full bg-white px-6 text-sm font-medium text-black shadow-lg transition-transform hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="index >= total - 1"
        @click="next"
      >
        <span>{{ $t('gallery.browse.next') }}</span>
        <Icon
          name="tabler:arrow-right"
          class="size-4"
        />
      </button>
    </div>
  </div>
</template>
