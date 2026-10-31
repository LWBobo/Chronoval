<script setup lang="ts">
import { isPanorama } from '~/utils/panorama'
import {
  buildTimelineLayout,
  getTimelineHeaderHeight,
  type TimelineDayGroup,
} from '~/utils/timeline'

interface Props {
  photos: Photo[]
  columns?: number | 'auto'
}

const props = withDefaults(defineProps<Props>(), {
  columns: 'auto',
})

const dayjs = useDayjs()
const router = useRouter()
const { t } = useI18n()

const { filteredPhotos, hasActiveFilters, activeFilters } = usePhotoFilters()
const { sortedPhotos } = usePhotoSort()

const displayPhotos = computed(() => {
  return hasActiveFilters.value ? filteredPhotos.value : sortedPhotos.value
})

const { currentPhotoIndex, isViewerOpen } = storeToRefs(useViewerState())
const { openPanoramaViewer } = useViewerState()

const isMobile = useMediaQuery('(max-width: 768px)')
const containerRef = ref<HTMLElement>()
const containerWidth = ref(0)

const dateRange = ref<string>()
const visibleCities = ref<string>()
const visiblePhotos = ref(new Set<number>())

const scrollPercent = ref(0)
const isScrubbing = ref(false)

// 只挂载视口附近的日期。外层高度始终是整条时间轴，继续下滑不会把页面缩短。
const VIEWPORT_PAD = 800
const MOUNT_PAD = 1800
const viewportTop = ref(0)
const viewportBottom = ref(1200)

const measureWidth = () => {
  if (!containerRef.value) return
  // Reserve scrubber gutter on desktop
  const gutter = isMobile.value ? 4 : 56
  containerWidth.value = Math.max(0, containerRef.value.clientWidth - gutter)
}

const timeline = computed(() => {
  const list = displayPhotos.value ?? []
  if (!list.length || containerWidth.value <= 0) {
    return { days: [] as TimelineDayGroup[], months: [], totalHeight: 0 }
  }
  return buildTimelineLayout(list, {
    containerWidth: containerWidth.value,
    isMobile: isMobile.value,
    dayjs,
    t,
  })
})

const visibleDays = computed(() => {
  const days = timeline.value.days
  const top = viewportTop.value - MOUNT_PAD
  const bottom = viewportBottom.value + MOUNT_PAD
  return days.filter((day) => day.top + day.height >= top && day.top <= bottom)
})

const photoDocumentTop = (photoId: string) => {
  const header = getTimelineHeaderHeight(isMobile.value)
  for (const day of timeline.value.days) {
    const item = day.photos.find((entry) => entry.photo.id === photoId)
    if (!item) continue
    return timelineOrigin() + day.top + header + item.box.top
  }
  return null
}

const captureAnchor = () => {
  const nodes = containerRef.value?.querySelectorAll('[data-photo-id]')
  if (!nodes?.length) return null
  const vh = window.innerHeight
  let best: { id: string; clientTop: number } | null = null
  nodes.forEach((node) => {
    const rect = (node as HTMLElement).getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > vh) return
    const id = node.getAttribute('data-photo-id')
    if (!id) return
    if (!best || Math.abs(rect.top) < Math.abs(best.clientTop)) {
      best = { id, clientTop: rect.top }
    }
  })
  return best
}

// 后台补齐照片会重排时间轴。记下当前视口里的那张，排完后把它留在原来的位置。
watch(
  () => [displayPhotos.value, containerWidth.value, isMobile.value] as const,
  async (curr, prev) => {
    if (!prev || import.meta.server || isScrubbing.value) {
      nextTick(() => updateViewport())
      return
    }
    const anchor = captureAnchor()
    await nextTick()
    updateViewport()
    if (!anchor) return
    const top = photoDocumentTop(anchor.id)
    if (top == null) return
    const nextScroll = Math.max(0, top - anchor.clientTop)
    const current = window.pageYOffset || document.documentElement.scrollTop
    if (Math.abs(current - nextScroll) < 2) return
    window.scrollTo({ top: nextScroll, behavior: 'auto' })
    updateViewport()
  },
)

const isDayActive = (day: TimelineDayGroup) => {
  const top = day.top
  const bottom = day.top + day.height
  return (
    bottom >= viewportTop.value - VIEWPORT_PAD &&
    top <= viewportBottom.value + VIEWPORT_PAD
  )
}

const handleVisibilityChange = ({
  index,
  isVisible,
}: {
  index: number
  isVisible: boolean
  date: string | Date
}) => {
  if (isVisible) {
    visiblePhotos.value.add(index)
  } else {
    visiblePhotos.value.delete(index)
  }
  updateDateRange()
}

const updateDateRange = () => {
  if (visiblePhotos.value.size === 0) {
    dateRange.value = undefined
    visibleCities.value = undefined
    return
  }

  const visiblePhotosArray = Array.from(visiblePhotos.value)

  const visibleDates = visiblePhotosArray
    .map((index) => displayPhotos.value[index]?.dateTaken)
    .filter((date): date is string => Boolean(date))
    .map((date) => dayjs(date))
    .sort((a, b) => (a.isBefore(b) ? -1 : 1))

  const cities = visiblePhotosArray
    .map((index) => displayPhotos.value[index]?.city)
    .filter((city): city is string => Boolean(city))

  const uniqueCities = [...new Set(cities)]

  if (uniqueCities.length === 0) {
    visibleCities.value = undefined
  } else if (uniqueCities.length === 1) {
    visibleCities.value = uniqueCities[0]
  } else if (uniqueCities.length <= 3) {
    visibleCities.value = uniqueCities.join('、')
  } else {
    visibleCities.value =
      `${uniqueCities.slice(0, 2).join('、')} ` +
      t('ui.indexPanelCountCity', { count: uniqueCities.length })
  }

  if (visibleDates.length === 0) {
    dateRange.value = undefined
    return
  }

  const startDate = visibleDates[0]
  const endDate = visibleDates[visibleDates.length - 1]
  if (!startDate || !endDate) {
    dateRange.value = undefined
    return
  }

  if (startDate.isSame(endDate, 'day')) {
    dateRange.value = startDate.format('ll')
  } else if (startDate.isSame(endDate, 'month')) {
    dateRange.value = startDate.format('MMM YYYY')
  } else if (startDate.isSame(endDate, 'year')) {
    dateRange.value = `${startDate.format('MMM')} - ${endDate.format('MMM YYYY')}`
  } else {
    dateRange.value = `${startDate.format('ll')} - ${endDate.format('ll')}`
  }
}

/** Scroll position measured from the timeline box, not the document top.
 *  The filter banner sits above the timeline, so window scroll and day.top
 *  are different coordinate systems. */
const timelineOrigin = () => {
  const el = containerRef.value
  if (!el) return 0
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop
  return el.getBoundingClientRect().top + scrollTop
}

const updateViewport = () => {
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop
  const vh = window.innerHeight
  const origin = timelineOrigin()
  const localTop = scrollTop - origin
  viewportTop.value = localTop
  viewportBottom.value = localTop + vh

  const total = timeline.value.totalHeight
  if (total > 0 && !isScrubbing.value) {
    scrollPercent.value = Math.min(1, Math.max(0, localTop / total))
  }
}

// 筛选条件本身变化时，结果集和旧滚动位置对不上，回到时间轴顶部。
// 只是后台又补进一批照片时不滚，避免把正在看的位置拉回去。
watch(
  () =>
    hasActiveFilters.value
      ? JSON.stringify(activeFilters.value)
      : '',
  (key, prev) => {
    if (!key || prev === undefined || key === prev) return
    nextTick(() => {
      requestAnimationFrame(() => {
        const el = containerRef.value
        if (el) {
          const scrollTop =
            window.pageYOffset || document.documentElement.scrollTop
          const top = el.getBoundingClientRect().top + scrollTop - 48
          window.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
        }
        updateViewport()
      })
    })
  },
)

const onScrub = (percent: number) => {
  scrollPercent.value = percent
  const targetY = percent * Math.max(timeline.value.totalHeight, 1)
  const maxScroll = Math.max(
    1,
    document.documentElement.scrollHeight - window.innerHeight,
  )
  const galleryTop = containerRef.value?.offsetTop ?? 0
  window.scrollTo({
    top: Math.min(maxScroll, galleryTop + targetY),
    behavior: 'auto',
  })
  updateViewport()
}

const handleOpenViewer = (index: number) => {
  const photo = displayPhotos.value[index]
  if (photo && isPanorama(photo)) {
    openPanoramaViewer(photo)
    return
  }
  router.push(`/${photo?.id}`)
}

const scrollToPhoto = (photoIndex: number) => {
  const photoId = displayPhotos.value[photoIndex]?.id
  if (!photoId) return
  const top = photoDocumentTop(photoId)
  if (top == null) return
  window.scrollTo({
    top: Math.max(0, top - window.innerHeight / 2),
    behavior: 'smooth',
  })
  updateViewport()
}

watch(currentPhotoIndex, (newIndex) => {
  if (isViewerOpen.value && newIndex >= 0) {
    nextTick(() => scrollToPhoto(newIndex))
  }
})

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  measureWidth()
  updateViewport()
  window.addEventListener('scroll', updateViewport, { passive: true })
  window.addEventListener('resize', measureWidth, { passive: true })

  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => measureWidth())
    resizeObserver.observe(containerRef.value)
  }

  nextTick(() => {
    if (currentPhotoIndex.value) {
      scrollToPhoto(currentPhotoIndex.value)
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('scroll', updateViewport)
  window.removeEventListener('resize', measureWidth)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="relative w-full">
    <MasonryActiveFiltersHero v-if="hasActiveFilters" />

    <!-- Floating date range (wired from visible photos) -->
    <UiDateRangeIndicator
      :date-range="dateRange"
      :locations="visibleCities"
      :is-visible="!!dateRange && !isScrubbing"
      :is-mobile="isMobile"
    />

    <!-- Side timeline scrubber -->
    <TimelineScrubber
      v-if="timeline.months.length > 0"
      :months="timeline.months"
      :total-height="timeline.totalHeight"
      :scroll-percent="scrollPercent"
      @scrub="onScrub"
      @scrub-start="isScrubbing = true"
      @scrub-stop="isScrubbing = false"
    />

    <div :class="isMobile ? 'pb-1' : 'pr-12'">
      <div ref="containerRef" class="relative w-full px-0.5 sm:px-1">
        <div
          class="relative w-full"
          :style="{ height: `${timeline.totalHeight || 0}px` }"
        >
          <TimelineDayGroup
            v-for="day in visibleDays"
            :key="day.key"
            :group="day"
            :is-mobile="isMobile"
            :active="isDayActive(day)"
            @open-viewer="handleOpenViewer"
            @visibility-change="handleVisibilityChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>
