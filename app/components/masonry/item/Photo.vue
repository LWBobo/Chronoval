<script setup lang="ts">
import { motion, useDomRef } from 'motion-v'
import { useLivePhotoSource } from '~/composables/useLivePhotoSource'
import { canPrefetchLivePhoto } from '~/composables/useLivePhotoProcessor'
import { isPanorama } from '~/utils/panorama'

interface Props {
  photo: Photo
  index: number
  columnWidth?: number
  /** When set with boxHeight, fill a fixed justified-layout cell (Immich-style) */
  boxWidth?: number
  boxHeight?: number
}

const props = withDefaults(defineProps<Props>(), {
  columnWidth: 250,
})

const fillMode = computed(
  () =>
    props.boxWidth != null &&
    props.boxHeight != null &&
    props.boxWidth > 0 &&
    props.boxHeight > 0,
)
const emit = defineEmits<{
  'visibility-change': [
    { index: number; isVisible: boolean; date: string | Date },
  ]
  openViewer: [number]
}>()

const { gtag } = useGtag()

const isLoading = ref(true)
const photoRef = ref<HTMLElement>()
const videoRef = useDomRef()
const isVisible = ref(false)
const containerWidth = ref(0)

const isHovering = ref(false)
const isVideoPlaying = ref(false)
const livePhotoQueued = ref(false)

const isTouching = ref(false)
const touchCount = ref(0)
const longPressTimer = ref<NodeJS.Timeout | null>(null)
const initialTouchPos = ref<{ x: number; y: number } | null>(null)
const isMobile = useMediaQuery('(max-width: 768px)')

// 画廊照片卡片圆角：由后台「外观」设置控制，默认关闭（圆角 0），开启后按设定值生效
const cardCornerEnabled = useSettingRef('app:appearance.cardCornerRadius')
const cardCornerValue = useSettingRef('app:appearance.cardCornerRadiusValue')
const cardRadius = computed(() => {
  if (!cardCornerEnabled.value) return '0px'
  return `${Number(cardCornerValue.value) || 0}px`
})

const intersectionObserverRef = ref<IntersectionObserver | null>(null)

const {
  src: liveVideoSrc,
  processingState,
  load: loadLivePhoto,
  onError: handleLivePhotoError,
} = useLivePhotoSource(
  () => props.photo,
  () => isVisible.value || isHovering.value || isTouching.value,
)
const hasLivePhoto = computed(() =>
  Boolean(props.photo.isLivePhoto && props.photo.livePhotoVideoUrl),
)

const aspectRatio = computed(() => {
  // Priority 1: Use aspectRatio from photo data if available (width/height)
  if (props.photo.aspectRatio) {
    return props.photo.aspectRatio
  }

  // Priority 2: Calculate from width and height (CSS aspect-ratio = w/h)
  if (props.photo.width && props.photo.height) {
    return props.photo.width / props.photo.height
  }

  // Fallback: Default aspect ratio
  return 1.2
})

// 卡片实际渲染高度 ≈ 列宽 ÷ aspectRatio（aspectRatio 为 CSS 长宽比 width/height）。
// 用于给 `content-visibility` 跳过渲染的视口外卡片提供正确的固有高度，
// 避免首帧瀑布流用固定兜底 320px 参与排版导致首页排版错乱（首图莫名放大）。
const intrinsicSize = computed(() => {
  if (fillMode.value) return Math.round(props.boxHeight!)
  const height = Math.round((props.columnWidth || 250) / aspectRatio.value)
  return Math.max(height, 100)
})

// EXIF 项定义（保证顺序：焦距 · 光圈 · 快门 · ISO）
const exifItems = computed<{ icon: string; text: string }[]>(() => {
  const items: { icon: string; text: string }[] = []
  const exif = props.photo.exif
  if (exif?.FocalLengthIn35mmFormat) {
    items.push({
      icon: 'streamline:image-accessories-lenses-photos-camera-shutter-picture-photography-pictures-photo-lens',
      text: String(exif.FocalLengthIn35mmFormat),
    })
  }
  if (exif?.FNumber) {
    items.push({ icon: 'tabler:aperture', text: `f/${exif.FNumber}` })
  }
  if (exif?.ExposureTime) {
    items.push({
      icon: 'carbon:time',
      text: formatExposureTime(exif.ExposureTime),
    })
  }
  if (exif?.ISO) {
    items.push({ icon: 'carbon:iso-outline', text: `ISO ${exif.ISO}` })
  }
  return items
})

// ===== 拍摄参数（EXIF）显示策略：按卡片高矮/长图形状分级=====
// 长图（渲染高度 > 宽度，即竖向）且足够高 → 显示全部 4 个；横向/矮图最多只显示 2 个；
// 两者放不下则降一档（4→2→0）。拍摄参数网格固定 2 列 →
// 每行 chip 约 32px、行距 8px、底部留白 16px，上方预留标题基线约 28px。
const exifBlockHeight = (count: number) => {
  const rows = Math.ceil(count / 2)
  return rows * 32 + (rows - 1) * 8 + 16
}

// 返回实际可显示的数量：长图优先 4→2→0，横向图 2→0
const visibleExifCount = computed(() => {
  const n = exifItems.value.length
  if (n === 0) return 0
  // 列宽太窄：2 列表格会让“焦距/ISO”等标签被压缩，直接整块隐藏
  if ((props.columnWidth || 250) < 220) return 0
  // 长图（渲染高度 > 列宽）才有资格显示全部 4 个；横向/矮图最多 2 个
  const isTall = intrinsicSize.value > (props.columnWidth || 250)
  const tiers = isTall ? [4, 2] : [2]
  for (const k of tiers) {
    if (k > n) continue
    // 卡片高度足以容纳“标题基线 + 对应项的拍摄参数块”才显示该档，否则降到下一档
    if (intrinsicSize.value >= exifBlockHeight(k) + 28) {
      return k
    }
  }
  return 0
})

const visibleExifItems = computed(() => {
  const n = visibleExifCount.value
  return n > 0 ? exifItems.value.slice(0, n) : []
})

// Show info overlay only when not playing video or video has finished
const shouldShowInfoOverlay = computed(() => {
  if (!props.photo.isLivePhoto) return true

  // On mobile, don't show overlay when touching or playing video
  if (isMobile.value) {
    if (isTouching.value || isVideoPlaying.value) return false
    return true
  }

  // On desktop, show overlay when hovering but not playing video
  if (!isHovering.value) return true
  return !isVideoPlaying.value
})

// Methods
const handleImageLoad = () => {
  isLoading.value = false
}

const handleImageError = () => {
  isLoading.value = false
  console.warn(`Failed to load image: ${props.photo.thumbnailUrl}`)
}

// 恢复旧版：下载完成后只把本地 Blob URL 挂到 video。
const ensureLiveVideoMounted = async () => {
  if (!hasLivePhoto.value || !(await loadLivePhoto())) return false
  await nextTick()
  return Boolean(videoRef.value)
}

const queueLivePhotoAfterStill = () => {
  if (
    livePhotoQueued.value ||
    isLoading.value ||
    !isVisible.value ||
    !hasLivePhoto.value ||
    !canPrefetchLivePhoto()
  )
    return
  livePhotoQueued.value = true
  const run = () => {
    if (!isVisible.value) {
      livePhotoQueued.value = false
      return
    }
    void loadLivePhoto(true)
  }
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(run, { timeout: 2000 })
  else setTimeout(run, 400)
}
watch([isVisible, isLoading], () => {
  if (!isVisible.value) {
    livePhotoQueued.value = false
    isVideoPlaying.value = false
  } else queueLivePhotoAfterStill()
})
watch(
  () => props.photo.id,
  () => {
    livePhotoQueued.value = false
    isVideoPlaying.value = false
  },
)

const handleMouseEnter = async () => {
  if (isMobile.value) return

  isHovering.value = true
  if (!hasLivePhoto.value) return

  if (!(await ensureLiveVideoMounted()) || !isHovering.value) return
  void playLivePhotoVideo()
}

const handleMouseLeave = () => {
  if (isMobile.value) return

  isHovering.value = false
  if (videoRef.value && !videoRef.value.paused) {
    videoRef.value.pause()
    videoRef.value.currentTime = 0
  }

  setTimeout(() => {
    if (!isHovering.value && !isTouching.value) {
      isVideoPlaying.value = false
    }
  }, 150)
}

const playLivePhotoVideo = async () => {
  if (
    !videoRef.value ||
    !liveVideoSrc.value ||
    !(isHovering.value || isTouching.value)
  )
    return
  const element = videoRef.value
  const source = liveVideoSrc.value
  element.muted = true
  element.playsInline = true
  try {
    element.currentTime = 0
    await element.play()
    if (
      source !== liveVideoSrc.value ||
      !(isHovering.value || isTouching.value)
    ) {
      element.pause()
      return
    }
    isVideoPlaying.value = true
  } catch {
    isVideoPlaying.value = false
  }
}
const handleLiveVideoPlaying = () => {
  if (isHovering.value || isTouching.value) isVideoPlaying.value = true
  else videoRef.value?.pause()
}

const handleVideoEnded = () => {
  // Provide haptic feedback on mobile when ending playback
  if (isMobile.value && 'vibrate' in navigator) {
    navigator.vibrate(30) // Shorter vibration for end
  }

  // Add a small delay before hiding video to make the transition smoother
  setTimeout(() => {
    isVideoPlaying.value = false
  }, 100)
}

// Mobile touch handlers for LivePhoto
const handleTouchStart = (event: TouchEvent) => {
  if (!isMobile.value || !hasLivePhoto.value) return

  touchCount.value = event.touches.length

  // Only handle single finger touch to avoid conflicts with pinch-to-zoom and scrolling
  if (event.touches.length === 1) {
    const touch = event.touches[0]
    if (touch) {
      initialTouchPos.value = { x: touch.clientX, y: touch.clientY }
      isTouching.value = true

      longPressTimer.value = setTimeout(() => {
        if (!(isTouching.value && touchCount.value === 1)) return
        void ensureLiveVideoMounted().then((ok) => {
          if (ok && isTouching.value) playLivePhotoVideo()
        })
      }, 350)
    }
  }
}

const handleTouchMove = (event: TouchEvent) => {
  if (!isMobile.value || !isTouching.value || !initialTouchPos.value) return

  touchCount.value = event.touches.length

  // If user adds more fingers, cancel LivePhoto playback
  if (event.touches.length > 1) {
    cancelLivePhotoTouch()
    return
  }

  // Check if user is moving finger significantly (scrolling intent)
  const touch = event.touches[0]
  if (touch) {
    const deltaX = Math.abs(touch.clientX - initialTouchPos.value.x)
    const deltaY = Math.abs(touch.clientY - initialTouchPos.value.y)
    const threshold = 10 // pixels

    // If movement exceeds threshold, cancel LivePhoto and allow scrolling
    if (deltaX > threshold || deltaY > threshold) {
      cancelLivePhotoTouch()
    }
  }
}

const handleTouchEnd = () => {
  if (!isMobile.value) return

  cancelLivePhotoTouch()
}

const cancelLivePhotoTouch = () => {
  const wasPlaying = isVideoPlaying.value

  touchCount.value = 0
  isTouching.value = false
  initialTouchPos.value = null

  // Clear the long press timer
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value)
    longPressTimer.value = null
  }

  // Stop video playback
  if (videoRef.value && !videoRef.value.paused) {
    videoRef.value.pause()
    videoRef.value.currentTime = 0

    // Provide haptic feedback on mobile when manually stopping playback
    if (isMobile.value && wasPlaying && 'vibrate' in navigator) {
      navigator.vibrate(25) // Very short vibration for manual stop
    }
  }

  // Use a slight delay for smoother transition
  setTimeout(() => {
    if (!isTouching.value && !isHovering.value) {
      isVideoPlaying.value = false
    }
  }, 150)
}

// Handle click events - prevent opening viewer when video is playing
const handleClick = (event: Event) => {
  // On mobile, if video is playing or user is touching, don't open the viewer
  if (isMobile.value && (isVideoPlaying.value || isTouching.value)) {
    event.preventDefault()
    event.stopPropagation()
    return
  }

  // Track photo view event in Google Analytics
  gtag('event', 'photo_view', {
    photo_id: props.photo.id,
    photo_title: props.photo.title || 'Untitled',
    has_live_photo: props.photo.isLivePhoto ? 'yes' : 'no',
  })

  // On desktop, always allow opening the viewer
  // Otherwise, open the viewer
  emit('openViewer', props.index)
}

const formatExposureTime = (
  exposureTime: string | number | undefined,
): string => {
  if (!exposureTime) return ''

  let seconds: number

  // Handle different input formats
  if (typeof exposureTime === 'string') {
    // Try to parse fraction format like "1/60"
    if (exposureTime.includes('/')) {
      const parts = exposureTime.split('/')
      if (parts.length === 2 && parts[0] && parts[1]) {
        const numerator = parseFloat(parts[0])
        const denominator = parseFloat(parts[1])
        if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
          seconds = numerator / denominator
        } else {
          return exposureTime // Return original if can't parse
        }
      } else {
        return exposureTime // Return original if format is unexpected
      }
    } else {
      // Try to parse as decimal
      seconds = parseFloat(exposureTime)
      if (isNaN(seconds)) {
        return exposureTime // Return original if can't parse
      }
    }
  } else {
    seconds = exposureTime
  }

  // Convert to fraction format
  if (seconds >= 1) {
    // For exposures 1 second or longer, show as decimal with "s"
    return `${seconds}s`
  } else {
    // For fast exposures, convert to 1/x format
    const denominator = Math.round(1 / seconds)
    return `1/${denominator}`
  }
}

// Set up intersection observer for visibility tracking (LivePhoto 等仅在可见时处理)
// 注意：缩略图加载由 <ThumbImage> 内部的 loading="lazy" + IntersectionObserver 负责，
// isLoading 由它的 @load/@error 事件驱动（模板已绑定），这里不再额外 new Image() 预加载，
// 避免数百张卡片在挂载瞬间同时创建 Image 对象导致主线程阻塞。
onMounted(() => {
  nextTick(() => {
    if (photoRef.value) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const newVisibility = entry.isIntersecting
            if (newVisibility !== isVisible.value) {
              isVisible.value = newVisibility
              emit('visibility-change', {
                index: props.index,
                isVisible: newVisibility,
                date: props.photo.dateTaken || new Date().toISOString(),
              })
            }
          })
        },
        {
          threshold: 0.1, // Trigger when 10% of the item is visible
          rootMargin: '50px 0px 50px 0px', // Add some margin for smoother transitions
        },
      )

      observer.observe(photoRef.value)
      intersectionObserverRef.value = observer
    }
  })
})

// Cleanup observers on unmount
onUnmounted(() => {
  if (intersectionObserverRef.value) {
    intersectionObserverRef.value.disconnect()
  }

  // Clean up touch timer
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value)
    longPressTimer.value = null
  }
})
</script>

<template>
  <div
    ref="photoRef"
    class="photo-card transition-transform duration-300 cursor-pointer select-none"
    :class="fillMode ? 'h-full w-full' : 'w-full'"
    :style="{
      'contain-intrinsic-size': `auto ${intrinsicSize}px`,
      borderRadius: cardRadius,
    }"
    @click="handleClick"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
    @touchcancel="handleTouchEnd"
    @contextmenu.prevent=""
  >
    <div
      class="relative group overflow-hidden bg-neutral-900 transition-transform duration-300"
      :class="fillMode ? 'h-full w-full' : ''"
      :style="{ borderRadius: cardRadius }"
    >
      <!-- Container: aspect-ratio for masonry columns, or fill fixed justified cell -->
      <div
        class="relative"
        :class="fillMode ? 'h-full w-full' : 'w-full'"
        :style="fillMode ? undefined : { aspectRatio }"
      >
        <ThumbImage
          :src="photo.thumbnailUrl || ''"
          :alt="photo.title || $t('ui.photo.altFallback')"
          :thumbhash="photo.thumbnailHash || ''"
          class="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          @load="handleImageLoad"
          @error="handleImageError"
        />

        <!-- LivePhoto：使用已下载的 Blob，真正播放后才显示视频层 -->
        <motion.video
          v-if="liveVideoSrc"
          ref="videoRef"
          :src="liveVideoSrc"
          class="absolute inset-0 w-full h-full object-cover"
          :class="{ 'select-none pointer-events-none': isVideoPlaying }"
          muted
          playsinline
          preload="metadata"
          :initial="{
            opacity: 0,
            scale: 1.02,
          }"
          :animate="{
            opacity: isVideoPlaying ? 1 : 0,
            scale: isVideoPlaying ? 1 : 1.02,
          }"
          :transition="{
            duration: isVideoPlaying ? 0.3 : 0.2,
            ease: isVideoPlaying
              ? [0.23, 1, 0.32, 1]
              : [0.25, 0.46, 0.45, 0.94],
            delay: isVideoPlaying ? 0.05 : 0,
          }"
          @playing="handleLiveVideoPlaying"
          @error="
            (event) => {
              isVideoPlaying = false
              handleLivePhotoError(event)
            }
          "
          @ended="handleVideoEnded"
        />
      </div>

      <!-- 底部渐变叠加层（Afilmory：独立图层，悬停淡入） -->
      <div
        v-if="!isLoading"
        class="pointer-events-none absolute inset-0 bg-linear-to-t from-black/80 via-black/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />

      <!-- 左上角角标区：全景 / 实况照片，纵向排列 -->
      <div
        class="pointer-events-none absolute top-2 left-2 flex flex-col items-start gap-1"
      >
        <PanoramaBadge
          v-if="isPanorama(photo)"
          :photo="photo"
        />
        <PhotoLivePhotoIndicator
          v-if="photo.isLivePhoto"
          :photo="photo"
          :is-video-playing="isVideoPlaying"
          :processing-state="processingState"
        />
      </div>

      <!-- 图片信息与 EXIF 叠加层（Afilmory 精确复刻） -->
      <div
        v-if="!isLoading"
        class="pointer-events-none absolute inset-x-0 bottom-0 p-4 pb-0 text-white"
      >
        <div class="mb-3">
          <h3
            v-if="photo.title"
            class="mb-2 truncate text-sm font-medium opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          >
            {{ photo.title }}
          </h3>

          <p
            v-if="photo.description"
            class="mb-2 line-clamp-2 text-sm text-white/80 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          >
            {{ photo.description }}
          </p>

          <!-- Tags -->
          <div
            v-if="photo.tags?.length"
            class="flex flex-wrap gap-1.5"
          >
            <span
              v-for="tag in photo.tags"
              :key="tag"
              class="rounded-full bg-white/20 px-2 py-0.5 text-xs text-white/90 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-hover:backdrop-blur-sm"
            >
              {{ tag }}
            </span>
          </div>
        </div>

        <!-- 拍摄参数（EXIF）网格：按卡片高度分级（4 → 2 → 0），常驻显示 + 悬停高斯模糊；
             卡片够高放得下拍摄参数才显示，越矮显示的项数越少，放不下则整块隐藏 -->
        <div
          v-if="visibleExifItems.length > 0"
          class="grid grid-cols-2 gap-2 pb-4 text-xs"
        >
          <div
            v-for="item in visibleExifItems"
            :key="item.text"
            class="flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-hover:backdrop-blur-sm"
          >
            <Icon
              :name="item.icon"
              class="shrink-0 text-white/70"
            />
            <span class="whitespace-nowrap text-white/90">{{ item.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 性能：用 content-visibility 跳过屏幕外卡片的绘制（水墙图片高度由 aspectRatio 预留，
   不会引起滚动跳动）；固有高度单张内联按真实长宽比计算（colWidth÷aspectRatio），
   保证首帧视口外卡片以正确高度参与瀑布流排版；此处 320px 仅为极少数缺宽高数据的兜底。
   不再给每张卡强制 will-change/translateZ 常驻合成层，
   否则几百张卡会生成几千个 GPU 图层，滚动时逐层合成导致卡顿。
   悬浮 scale/淡入仅在悬停瞬间由 motion/WAAPI 触发，天然走合成器，无需常驻 will-change。 */
.photo-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
  isolation: isolate;
}
</style>
