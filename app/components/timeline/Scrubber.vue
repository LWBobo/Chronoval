<script lang="ts" setup>
import type { TimelineMonthSegment } from '~/utils/timeline'

/**
 * Immich-style side timeline scrubber.
 * Segments scale with month content height; drag/hover seeks the main scroll.
 */
const props = withDefaults(
  defineProps<{
    months: TimelineMonthSegment[]
    totalHeight: number
    /** Current overall scroll progress 0–1 */
    scrollPercent: number
    /** Hover label date text from parent (optional override) */
    hoverLabel?: string
  }>(),
  {
    hoverLabel: '',
  },
)

const emit = defineEmits<{
  scrub: [percent: number]
  'scrub-start': []
  'scrub-stop': []
}>()

const { t } = useI18n()
const isMobile = useMediaQuery('(max-width: 768px)')
const rootRef = ref<HTMLElement | null>(null)

const isDragging = ref(false)
const isHovering = ref(false)
const hoverY = ref(0)
const hoverPercent = ref(0)
const scrolling = ref(false)
let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null

const PADDING_TOP = 28
const PADDING_BOTTOM = 12
const MIN_YEAR_GAP = 18
const MIN_DOT_GAP = 10

const { height: windowHeight } = useWindowSize()
const trackHeight = computed(() => Math.max(200, (windowHeight.value || 800) - 80))

const usableHeight = computed(() =>
  Math.max(1, trackHeight.value - PADDING_TOP - PADDING_BOTTOM),
)

type SegmentView = TimelineMonthSegment & {
  viewHeight: number
  viewTop: number
  hasYearLabel: boolean
  hasDot: boolean
}

const segments = computed<SegmentView[]>(() => {
  const total = Math.max(1, props.totalHeight)
  let viewTop = 0
  let sinceYear = Infinity
  let sinceDot = Infinity
  let lastYear = Number.NaN

  return props.months.map((m) => {
    const viewHeight = Math.max(2, (m.height / total) * usableHeight.value)
    const yearChanged = m.year !== lastYear
    const hasYearLabel =
      yearChanged && m.year > 0 && sinceYear >= MIN_YEAR_GAP
    const hasDot = !hasYearLabel && sinceDot >= MIN_DOT_GAP

    if (hasYearLabel) {
      sinceYear = 0
      sinceDot = 0
      lastYear = m.year
    } else if (hasDot) {
      sinceDot = 0
      sinceYear += viewHeight
    } else {
      sinceYear += viewHeight
      sinceDot += viewHeight
    }

    const seg: SegmentView = {
      ...m,
      viewHeight,
      viewTop,
      hasYearLabel,
      hasDot,
    }
    viewTop += viewHeight
    return seg
  })
})

const indicatorY = computed(() => {
  const p = isDragging.value || isHovering.value
    ? hoverPercent.value
    : props.scrollPercent
  return PADDING_TOP + Math.min(1, Math.max(0, p)) * usableHeight.value
})

const activeHoverLabel = computed(() => {
  if (props.hoverLabel) return props.hoverLabel
  const p = hoverPercent.value
  const y = p * usableHeight.value
  for (const seg of segments.value) {
    if (y >= seg.viewTop && y <= seg.viewTop + seg.viewHeight) {
      return seg.label
    }
  }
  return segments.value[0]?.label ?? ''
})

const showHoverChip = computed(
  () => (isDragging.value || isHovering.value) && !!activeHoverLabel.value,
)

const scrubberExpanded = computed(() => {
  if (!isMobile.value) return true
  return isDragging.value || scrolling.value || isHovering.value
})

const onWindowScroll = () => {
  if (!isMobile.value) return
  scrolling.value = true
  if (scrollIdleTimer) clearTimeout(scrollIdleTimer)
  scrollIdleTimer = setTimeout(() => {
    scrolling.value = false
  }, 900)
}

const percentFromClientY = (clientY: number) => {
  const el = rootRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  const y = clientY - rect.top - PADDING_TOP
  return Math.min(1, Math.max(0, y / usableHeight.value))
}

const applyPointer = (clientY: number) => {
  const p = percentFromClientY(clientY)
  hoverY.value = clientY
  hoverPercent.value = p
  emit('scrub', p)
}

const onPointerDown = (e: PointerEvent) => {
  isDragging.value = true
  isHovering.value = true
  emit('scrub-start')
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  applyPointer(e.clientY)
}

const onPointerMove = (e: PointerEvent) => {
  if (!isDragging.value && !isHovering.value) return
  if (isDragging.value) {
    applyPointer(e.clientY)
  } else {
    hoverPercent.value = percentFromClientY(e.clientY)
    hoverY.value = e.clientY
  }
}

const onPointerUp = () => {
  if (isDragging.value) {
    isDragging.value = false
    emit('scrub-stop')
  }
}

const onPointerEnter = (e: PointerEvent) => {
  isHovering.value = true
  hoverPercent.value = percentFromClientY(e.clientY)
}

const onPointerLeave = () => {
  if (!isDragging.value) {
    isHovering.value = false
  }
}

onMounted(() => {
  window.addEventListener('scroll', onWindowScroll, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('scroll', onWindowScroll)
  if (scrollIdleTimer) clearTimeout(scrollIdleTimer)
})
</script>

<template>
  <aside
    ref="rootRef"
    class="timeline-scrubber fixed z-40 select-none"
    :class="scrubberExpanded ? 'is-expanded' : 'is-collapsed'"
    :style="{
      top: '64px',
      bottom: '16px',
      right: 0,
      width: isMobile ? (scrubberExpanded ? '28px' : '0px') : '56px',
    }"
    :aria-label="t('ui.timeline.scrubberLabel')"
    role="slider"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="Math.round(scrollPercent * 100)"
    @pointerdown.prevent="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
  >
    <!-- Hover date chip -->
    <div
      v-if="showHoverChip"
      class="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white shadow-lg dark:bg-white dark:text-neutral-900"
      :style="{
        top: `${indicatorY - 14}px`,
      }"
    >
      {{ activeHoverLabel }}
    </div>

    <!-- Track -->
    <div
      class="relative h-full w-full"
      :style="{ paddingTop: `${PADDING_TOP}px`, paddingBottom: `${PADDING_BOTTOM}px` }"
    >
      <div
        v-for="seg in segments"
        :key="seg.key"
        class="absolute right-0 flex w-full items-start justify-end pr-2"
        :style="{
          top: `${PADDING_TOP + seg.viewTop}px`,
          height: `${seg.viewHeight}px`,
        }"
      >
        <span
          v-if="seg.hasYearLabel"
          class="translate-y-[-2px] text-[10px] font-semibold tabular-nums text-neutral-500 dark:text-neutral-400"
        >
          {{ seg.year }}
        </span>
        <span
          v-else-if="seg.hasDot"
          class="mt-0.5 size-1 rounded-full bg-neutral-400/80 dark:bg-neutral-500"
          aria-hidden="true"
        />
      </div>

      <!-- Position indicator -->
      <div
        class="pointer-events-none absolute right-1 h-0.5 w-3 rounded-full bg-neutral-800 dark:bg-neutral-100"
        :style="{ top: `${indicatorY}px` }"
      />
    </div>
  </aside>
</template>

<style scoped>
.timeline-scrubber {
  touch-action: none;
  cursor: ns-resize;
  transition: width 180ms ease;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--color-neutral-950, #0a0a0a) 4%, transparent) 40%,
    color-mix(in srgb, var(--color-neutral-950, #0a0a0a) 8%, transparent) 100%
  );
}

:global(.dark) .timeline-scrubber {
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.03) 40%,
    rgba(255, 255, 255, 0.06) 100%
  );
}

.timeline-scrubber.is-collapsed {
  overflow: hidden;
  pointer-events: none;
}

@media (max-width: 768px) {
  .timeline-scrubber.is-expanded {
    pointer-events: auto;
    background: color-mix(in srgb, var(--color-neutral-950, #0a0a0a) 12%, transparent);
  }
}
</style>
