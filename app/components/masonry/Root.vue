<script setup lang="ts">
import { isPanorama } from '~/utils/panorama'
import { buildTimelineLayout, type TimelineDayGroup } from '~/utils/timeline'

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

const { filteredPhotos, hasActiveFilters } = usePhotoFilters()
const { sortedPhotos } = usePhotoSort()

const displayPhotos = computed(() => {
  return hasActiveFilters.value ? filteredPhotos.value : sortedPhotos.value
})

const { currentPhotoIndex, isViewerOpen } = storeToRefs(useViewerState())
const { openPanoramaViewer } = useViewerState()

const { batchProcessLivePhotos } = useLivePhotoProcessor()
const processedBatch = ref(new Set<string>())

const isMobile = useMediaQuery('(max-width: 768px)')
const containerRef = ref<HTMLElement>()
const containerWidth = ref(0)

const showFloatingActions = ref(false)
const dateRange = ref<string>()
const visibleCities = ref<string>()
const visiblePhotos = ref(new Set<number>())

const scrollPercent = ref(0)
const isScrubbing = ref(false)

// Virtualization: only mount day groups near the viewport
const VIEWPORT_PAD = 800
const viewportTop = ref(0)
const viewportBottom = ref(1200)

// Incremental day mounting for first paint
const renderedDayCount = ref(0)
const INCREMENT_DAYS = 12
const sentinelRef = ref<HTMLElement>()
const loadMoreObserver = ref<IntersectionObserver | null>(null)

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
  const end = Math.min(renderedDayCount.value || 0, days.length)
  return days.slice(0, end)
})

watch(
  () => [displayPhotos.value, containerWidth.value, isMobile.value] as const,
  (curr, prev) => {
    const n = timeline.value.days.length
    const photosChanged = !prev || curr[0] !== prev[0]
    if (photosChanged || renderedDayCount.value === 0) {
      renderedDayCount.value = n ? Math.min(INCREMENT_DAYS, n) : 0
    } else if (renderedDayCount.value > n) {
      renderedDayCount.value = n
    }
    nextTick(() => updateViewport())
  },
  { immediate: true },
)

const appendDays = () => {
  const total = timeline.value.days.length
  if (renderedDayCount.value >= total) return
  renderedDayCount.value = Math.min(
    renderedDayCount.value + INCREMENT_DAYS,
    total,
  )
}

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
  nextTick(() => processVisibleLivePhotos())
}

const processVisibleLivePhotos = async () => {
  const visiblePhotosArray = Array.from(visiblePhotos.value)
  const livePhotosToProcess = visiblePhotosArray
    .map((index) => displayPhotos.value[index])
    .filter(
      (photo): photo is Photo =>
        photo != null &&
        photo.isLivePhoto === 1 &&
        Boolean(photo.livePhotoVideoUrl) &&
        !processedBatch.value.has(photo.id),
    )

  if (livePhotosToProcess.length === 0) return

  livePhotosToProcess.forEach((photo) => {
    processedBatch.value.add(photo.id)
  })

  batchProcessLivePhotos(
    livePhotosToProcess.map((photo) => ({
      id: photo.id,
      livePhotoVideoUrl: photo.livePhotoVideoUrl!,
    })),
  )
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
  showFloatingActions.value = scrollTop > 500

  const total = timeline.value.totalHeight
  if (total > 0 && !isScrubbing.value) {
    scrollPercent.value = Math.min(1, Math.max(0, localTop / total))
  }
}

// 筛选结果变了之后，把时间轴顶部滚进视口。否则窗口还停在旧位置，
// 而缓冲区只挂载最前面的几天，画面里就没有照片。
watch(
  () =>
    hasActiveFilters.value
      ? displayPhotos.value.map((photo) => photo.id).join('\0')
      : '',
  (key, prev) => {
    if (!key || prev === undefined) return
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
  // Ensure day groups near the seek target are mounted
  const targetY = percent * Math.max(timeline.value.totalHeight, 1)
  const dayIdx = timeline.value.days.findIndex(
    (d) => d.top + d.height >= targetY,
  )
  if (dayIdx >= 0) {
    renderedDayCount.value = Math.max(
      renderedDayCount.value,
      Math.min(timeline.value.days.length, dayIdx + INCREMENT_DAYS),
    )
  }
  const maxScroll = Math.max(
    1,
    document.documentElement.scrollHeight - window.innerHeight,
  )
  const galleryTop = containerRef.value?.offsetTop ?? 0
  window.scrollTo({
    top: Math.min(maxScroll, galleryTop + targetY),
    behavior: 'auto',
  })
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
  if (!displayPhotos.value[photoIndex]) return
  const photoId = displayPhotos.value[photoIndex].id

  // Ensure the day containing this photo is rendered
  const dayIdx = timeline.value.days.findIndex((d) =>
    d.photos.some((p) => p.photo.id === photoId),
  )
  if (dayIdx >= 0 && dayIdx >= renderedDayCount.value) {
    renderedDayCount.value = Math.min(
      dayIdx + INCREMENT_DAYS,
      timeline.value.days.length,
    )
  }

  nextTick(() => {
    const photoElement = document.querySelector(`[data-photo-id="${photoId}"]`)
    if (!photoElement) return
    const elementRect = photoElement.getBoundingClientRect()
    const windowHeight = window.innerHeight
    const currentScrollY = window.pageYOffset
    const targetScrollY =
      currentScrollY +
      elementRect.top -
      windowHeight / 2 +
      elementRect.height / 2
    window.scrollTo({
      top: Math.max(0, targetScrollY),
      behavior: 'smooth',
    })
  })
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

  if (sentinelRef.value) {
    loadMoreObserver.value = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) appendDays()
      },
      { rootMargin: '1600px 0px 0px 0px', threshold: 0 },
    )
    loadMoreObserver.value.observe(sentinelRef.value)
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
  loadMoreObserver.value?.disconnect()
  loadMoreObserver.value = null
})
</script>

<template>
  <div class="relative w-full">
    <MasonryActiveFiltersHero v-if="hasActiveFilters" />

    <div class="hidden md:block">
      <MasonryFloatingActionButton :show-floating="showFloatingActions" />
    </div>

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

        <div
          v-if="renderedDayCount < timeline.days.length"
          ref="sentinelRef"
          class="h-px w-full"
          aria-hidden="true"
        />
      </div>
    </div>
  </div>
</template>
