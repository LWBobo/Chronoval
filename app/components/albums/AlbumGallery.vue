<script lang="ts" setup>
import type { AlbumLayout } from '~~/shared/types/album'

import { buildTimelineLayout } from '~/utils/timeline'

/**
 * 相簿照片展示容器：负责「瀑布流 / 统一网格 / 时间线」几种布局的骨架与顶部切换控件。
 * 具体卡片由父组件通过具名插槽提供（保留普通相簿丰富的卡片能力）：
 *   - #waterfall-card="{ photo, index, boxWidth?, boxHeight? }"  瀑布流 / 时间线 justified 卡片
 *   - #grid-card="{ photo, index }"       统一网格卡片
 *   - #lead="{ lead, variant }"           与照片同一格的前置项（如子相簿），位置由 leadPosition 决定
 */
const props = withDefaults(
  defineProps<{
    photos: any[]
    /** 与照片同一套布局格子里展示的项（如子相簿） */
    leads?: any[]
    /** 这些格子排在照片开头还是末尾 */
    leadPosition?: 'start' | 'end'
    /** 是否展示右上角「样式布局」切换控件（相簿详情默认展示） */
    showSwitch?: boolean
  }>(),
  { leads: () => [], leadPosition: 'start' },
)

const emit = defineEmits<{
  (e: 'open-random', index: number): void
}>()

const layout = defineModel<AlbumLayout>('layout', { default: 'waterfall' })

const { t } = useI18n()

// 瀑布流按列排布。不用会先清空再重排的瀑布流组件，避免滚动位置被夹回顶部。
const isMobile = useMediaQuery('(max-width: 768px)')

const leadList = computed(() => props.leads ?? [])
const leadAtEnd = computed(() => props.leadPosition === 'end')

const masonryItems = computed(() => {
  const leads = leadList.value.map((lead, index) => ({
    id: String(lead.id ?? lead.link ?? `lead-${index}`),
    lead,
    photo: null as any,
    originalIndex: -1,
    isLead: true,
  }))
  const photos = props.photos.map((photo, index) => ({
    id: photo.id,
    lead: null as any,
    photo,
    originalIndex: index,
    isLead: false,
  }))
  return leadAtEnd.value ? [...photos, ...leads] : [...leads, ...photos]
})

const hasItems = computed(
  () => props.photos.length > 0 || leadList.value.length > 0,
)

const LAYOUT_OPTIONS: { value: AlbumLayout; label: string; icon: string }[] = [
  // 图标与后台「管理相簿·编辑」的布局选项保持一致
  { value: 'waterfall', label: t('albums.layout.waterfall'), icon: 'tabler:layout-collage' },
  { value: 'grid', label: t('albums.layout.grid'), icon: 'tabler:layout-grid' },
  { value: 'immersive', label: t('albums.layout.immersive'), icon: 'tabler:photo' },
  { value: 'timeline', label: t('albums.layout.timeline'), icon: 'tabler:timeline' },
]

// —— 收缩式布局切换控件 ——
// 单一胶囊元素：收起态显示山体图标 + 照片数；点击后胶囊从中心向左右平滑展开，露出四个布局选项。
const expanded = ref(false)
const hovered = ref(false) // 桌面端鼠标悬停胶囊时显示彩虹光晕
const canHover = useMediaQuery('(hover: hover)') // 仅电脑端（支持悬停）才显示光晕
const switchRoot = ref<HTMLElement | null>(null)
const capsuleRef = ref<HTMLElement | null>(null)
const innerRef = ref<HTMLElement | null>(null)
const collapsedCapRef = ref<HTMLElement | null>(null)

/** 收起态胶囊宽度（风景图标 + 分隔线 + 照片数 + 分隔线 + 魔百盒） */
const collapsedWidth = ref(0)
/** 展开态胶囊宽度（四个布局选项） */
const expandedWidth = ref(0)

/** 有趣的魔百盒图标：点击随机预览一张相簿照片 */
const magicIcon = 'tabler:box'

// 测量收起态与展开态胶囊的自然宽度
const measureWidth = () => {
  if (collapsedCapRef.value) collapsedWidth.value = collapsedCapRef.value.offsetWidth
  if (innerRef.value) expandedWidth.value = innerRef.value.offsetWidth
}

// 组件挂载后测量
onMounted(() => {
  nextTick(() => measureWidth())
  // 字体加载完成后校正一次：i18n/Web 字体若在挂载时尚未就绪，测得的宽度会偏小，
  // 导致展开胶囊“只展开一点点”。字体就绪后再测一次即可修正。
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(() => nextTick(() => measureWidth()))
  }
})

// 监听窗口大小变化重新测量
useEventListener('resize', () => {
  measureWidth()
})

const toggleSwitch = () => {
  // 展开前即时重测最新宽度，确保不受异步字体/文案加载影响；
  // 也在收起后重测一次，保证下次展开仍用最新值。
  nextTick(() => measureWidth())
  expanded.value = !expanded.value
}

const pickLayout = (v: AlbumLayout) => {
  layout.value = v
  expanded.value = false
}

// 魔百盒：随机挑一张相簿照片预览
const openRandom = () => {
  const n = props.photos.length
  if (!n) return
  emit('open-random', Math.floor(Math.random() * n))
}

// —— 点击面板外部任意区域自动收起 ——
onClickOutside(switchRoot, () => {
  if (expanded.value) expanded.value = false
})

// —— 中心展开动画：容器宽度从收起态平滑过渡到展开态；外层 rounded-full 保证两端始终为圆弧 ——
const capsuleStyle = computed(() => {
  const full = expanded.value && expandedWidth.value > 0
    ? `${expandedWidth.value}px`
    : `${collapsedWidth.value || 160}px`
  return {
    width: full,
    transition: 'width 320ms cubic-bezier(0.33, 1, 0.68, 1)',
    transform: 'translateZ(0)',
    willChange: 'width',
  }
})

// 收起态主按钮：展开时快速淡出，避免与浮现的选项图标在中心叠加闪烁；收拢时等胶囊合拢后淡入
const collapseBtnStyle = computed(() => ({
  transition: expanded.value
    ? 'opacity 90ms ease-out 0ms'
    : 'opacity 200ms ease-out 60ms',
}))

// 展开选项行：展开时山体先快速淡出、选项随即同步淡入（重叠极短，无闪烁无空窗）；收拢时与胶囊合拢同步淡出
const optionsStyle = computed(() => ({
  transition: expanded.value
    ? 'opacity 300ms ease-out 30ms'
    : 'opacity 150ms ease-out 0ms',
}))

// —— Immich 式时间线：按日分组 + justified 行布局 + 侧边 scrubber ——
const dayjs = useDayjs()
const timelineContainerRef = ref<HTMLElement | null>(null)
const timelineWidth = ref(0)
const timelineScrollPercent = ref(0)
const timelineScrubbing = ref(false)

const measureTimelineWidth = () => {
  if (!timelineContainerRef.value) return
  const gutter = isMobile.value ? 4 : 56
  timelineWidth.value = Math.max(
    0,
    timelineContainerRef.value.clientWidth - gutter,
  )
}

const albumTimeline = computed(() => {
  if (layout.value !== 'timeline' || !props.photos.length || timelineWidth.value <= 0) {
    return { days: [], months: [], totalHeight: 0 }
  }
  return buildTimelineLayout(props.photos as Photo[], {
    containerWidth: timelineWidth.value,
    isMobile: isMobile.value,
    dayjs,
    t,
  })
})

const onTimelineScrub = (percent: number) => {
  timelineScrollPercent.value = percent
  const el = timelineContainerRef.value
  if (!el) return
  const top = el.getBoundingClientRect().top + window.pageYOffset
  window.scrollTo({
    top: top + percent * Math.max(albumTimeline.value.totalHeight, 1),
    behavior: 'auto',
  })
}

const onTimelineWindowScroll = () => {
  if (layout.value !== 'timeline' || timelineScrubbing.value) return
  const el = timelineContainerRef.value
  if (!el) return
  const top = el.getBoundingClientRect().top + window.pageYOffset
  const h = Math.max(albumTimeline.value.totalHeight, 1)
  const y = window.pageYOffset - top
  timelineScrollPercent.value = Math.min(1, Math.max(0, y / h))
}

watch(layout, (v) => {
  if (v === 'timeline') {
    nextTick(() => measureTimelineWidth())
  }
})

let timelineResizeObserver: ResizeObserver | null = null

onMounted(() => {
  nextTick(() => measureTimelineWidth())
  window.addEventListener('scroll', onTimelineWindowScroll, { passive: true })
  if (typeof ResizeObserver !== 'undefined') {
    timelineResizeObserver = new ResizeObserver(() => measureTimelineWidth())
    watch(
      timelineContainerRef,
      (el, _, onCleanup) => {
        timelineResizeObserver?.disconnect()
        if (el) {
          timelineResizeObserver?.observe(el)
          measureTimelineWidth()
        }
        onCleanup(() => timelineResizeObserver?.disconnect())
      },
      { immediate: true, flush: 'post' },
    )
  }
})

onUnmounted(() => {
  window.removeEventListener('scroll', onTimelineWindowScroll)
  timelineResizeObserver?.disconnect()
  timelineResizeObserver = null
})
</script>

<template>
  <div class="w-full">
    <!-- 顶部切换控件：仅在有照片且需要展示时渲染 -->
    <!-- 单一胶囊：收起态显示山体+数量，点击后胶囊从中心向左右平滑展开，露出四个布局选项 -->
    <div
      v-if="hasItems"
      ref="switchRoot"
      class="relative z-[40] mb-2 flex h-9 items-center justify-center"
    >
      <!-- 悬停彩虹光晕：四周柔和彩虹，仅桌面端悬停显示，展开态隐藏，覆盖到照片上层 -->
      <div
        aria-hidden="true"
        class="pointer-events-none absolute left-1/2 top-1/2 z-0 h-24 -translate-x-1/2 -translate-y-1/2 rounded-full"
        :style="{
          width: `calc(${capsuleStyle.width} + 96px)`,
          opacity: hovered && canHover && !expanded ? 1 : 0,
          filter: 'blur(46px) saturate(1.7)',
          transition: 'width 320ms cubic-bezier(0.33, 1, 0.68, 1), opacity 500ms ease',
          background: 'conic-gradient(from 0deg, #ff8a8a, #ffb65c, #ffd95e, #62d98a, #55b3ff, #a68bff, #ff7dd8, #ff8a8a)',
        }"
      ></div>
      <!-- 胶囊容器：宽度从收起态平滑过渡到展开态，居中定位，溢出隐藏 -->
      <div
        ref="capsuleRef"
        class="absolute left-1/2 flex h-8 -translate-x-1/2 items-center overflow-hidden rounded-full border border-neutral-200 bg-white/95 shadow-sm will-change-[width] dark:border-neutral-800 dark:bg-neutral-900/95"
        :style="capsuleStyle"
        @mouseenter="hovered = true"
        @mouseleave="hovered = false"
      >
        <!-- 收起态内容：风景图标 | 分隔线 | 照片数 | 分隔线 | 魔百盒，居中显示 -->
        <div
          ref="collapsedCapRef"
          class="absolute left-1/2 z-10 flex h-full -translate-x-1/2 transform-gpu items-center [backface-visibility:hidden]"
          :style="[
            { opacity: expanded ? 0 : 1 },
            { pointerEvents: expanded ? 'none' : 'auto' },
            collapseBtnStyle,
          ]"
        >
          <!-- 风景图标 + 分隔线 + 照片数：点击整块展开胶囊 -->
          <button
            type="button"
            class="flex h-full cursor-pointer items-center gap-2 pl-3 pr-2.5 transition-colors duration-200 hover:bg-neutral-100/50 dark:hover:bg-neutral-800/50"
            :title="t('albums.layout.switchLabel')"
            :aria-label="t('albums.layout.switchLabel')"
            :aria-expanded="expanded"
            @click="toggleSwitch"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0 size-4 text-neutral-500 dark:text-neutral-400"
              aria-hidden="true"
            >
              <path d="M3 19 8 10 11.5 15 14 7 21 19H3Z" />
            </svg>
            <span class="h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" aria-hidden="true" />
            <span class="text-xs font-semibold tabular-nums text-neutral-600 dark:text-neutral-300">
              {{ photos.length }}
            </span>
          </button>

          <!-- 分隔线 + 魔百盒：没有照片时不提供随机预览 -->
          <template v-if="photos.length">
          <span class="h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" aria-hidden="true" />

          <!-- 魔百盒：点击随机预览一张相簿照片 -->
          <button
            type="button"
            class="group flex h-full cursor-pointer items-center px-2.5 text-neutral-500 transition-colors duration-200 hover:bg-neutral-100/50 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800/50 dark:hover:text-neutral-200"
            :title="t('albums.layout.randomPreview')"
            :aria-label="t('albums.layout.randomPreview')"
            @click.stop="openRandom"
          >
            <Icon
              :name="magicIcon"
              class="shrink-0 size-4 text-neutral-500 transition-transform duration-500 group-hover:-rotate-12 group-hover:scale-110 group-active:scale-90 dark:text-neutral-400"
            />
          </button>
          </template>
        </div>

        <!-- 展开态内容：四个布局选项，每个为独立胶囊，文字图标不挤压，一行契合排列 -->
        <div
          ref="innerRef"
          class="absolute left-1/2 flex h-full -translate-x-1/2 transform-gpu items-center p-1 will-change-transform [backface-visibility:hidden]"
          :class="expanded ? 'opacity-100' : 'opacity-0'"
          :style="optionsStyle"
        >
          <button
            v-for="opt in LAYOUT_OPTIONS"
            :key="opt.value"
            type="button"
            class="group flex h-full shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-colors duration-200 [backface-visibility:hidden]"
            :class="
              layout === opt.value
                ? 'bg-neutral-900 text-white shadow-sm dark:bg-white dark:text-black'
                : 'text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white'
            "
            :aria-pressed="layout === opt.value"
            @click="pickLayout(opt.value)"
          >
            <Icon
              :name="opt.icon"
              class="size-3.5 shrink-0"
            />
            <span class="shrink-0">
              {{ opt.label }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- 瀑布流：按列排，追加照片时不拆掉已有格子，窗口停在原地 -->
    <div
      v-if="layout === 'waterfall'"
      class="columns-2 gap-1 sm:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6"
    >
      <div
        v-for="item in masonryItems"
        :key="item.id"
        class="mb-1 w-full break-inside-avoid"
      >
        <slot
          v-if="item.isLead"
          name="lead"
          :lead="item.lead"
          variant="waterfall"
        />
        <slot
          v-else
          name="waterfall-card"
          :photo="item.photo"
          :index="item.originalIndex"
        />
      </div>
    </div>

    <!-- 统一网格 -->
    <div
      v-else-if="layout === 'grid'"
      class="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8"
    >
      <template v-if="!leadAtEnd">
        <div v-for="(lead, index) in leadList" :key="lead.id ?? lead.link ?? index">
          <slot name="lead" :lead="lead" variant="grid" />
        </div>
      </template>
      <div v-for="(photo, index) in photos" :key="photo.id">
        <slot name="grid-card" :photo="photo" :index="index" />
      </div>
      <template v-if="leadAtEnd">
        <div v-for="(lead, index) in leadList" :key="`end-${lead.id ?? lead.link ?? index}`">
          <slot name="lead" :lead="lead" variant="grid" />
        </div>
      </template>
    </div>

    <!-- 沉浸式看图：单列全幅，向下滚动逐张浏览 -->
    <div v-else-if="layout === 'immersive'" class="mx-auto flex w-full flex-col gap-4 px-2 sm:px-4">
      <template v-if="!leadAtEnd">
        <div v-for="(lead, index) in leadList" :key="lead.id ?? lead.link ?? index">
          <slot name="lead" :lead="lead" variant="immersive" />
        </div>
      </template>
      <div v-for="(photo, index) in photos" :key="photo.id">
        <slot name="immersive-card" :photo="photo" :index="index" />
      </div>
      <template v-if="leadAtEnd">
        <div v-for="(lead, index) in leadList" :key="`end-${lead.id ?? lead.link ?? index}`">
          <slot name="lead" :lead="lead" variant="immersive" />
        </div>
      </template>
    </div>

    <!-- Immich 式时光线：按日分组 + justified 行布局 + 侧边 scrubber -->
    <div v-else-if="layout === 'timeline'" class="relative space-y-6">
      <div
        v-if="leadList.length && !leadAtEnd"
        class="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8"
      >
        <div v-for="(lead, index) in leadList" :key="lead.id ?? lead.link ?? index">
          <slot name="lead" :lead="lead" variant="grid" />
        </div>
      </div>

      <TimelineScrubber
        v-if="albumTimeline.months.length > 0"
        :months="albumTimeline.months"
        :total-height="albumTimeline.totalHeight"
        :scroll-percent="timelineScrollPercent"
        @scrub="onTimelineScrub"
        @scrub-start="timelineScrubbing = true"
        @scrub-stop="timelineScrubbing = false"
      />

      <div
        ref="timelineContainerRef"
        class="relative w-full"
        :class="isMobile ? '' : 'pr-12'"
        :style="{ height: `${albumTimeline.totalHeight || 40}px` }"
      >
        <section
          v-for="day in albumTimeline.days"
          :key="day.key"
          class="absolute left-0 w-full"
          :style="{ top: `${day.top}px`, height: `${day.height}px` }"
        >
          <header
            class="flex items-baseline gap-2 px-1"
            :style="{ height: isMobile ? '32px' : '48px' }"
          >
            <h2 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100 sm:text-base">
              {{ day.title }}
            </h2>
            <span
              v-if="day.cities.length"
              class="truncate text-xs text-neutral-500 dark:text-neutral-400"
            >
              {{ day.cities.slice(0, 2).join(' · ') }}
            </span>
            <span class="ml-auto text-xs tabular-nums text-neutral-400">
              {{ day.photos.length }}
            </span>
          </header>
          <div class="relative w-full" :style="{ height: `${day.contentHeight}px` }">
            <div
              v-for="item in day.photos"
              :key="item.photo.id"
              class="absolute overflow-hidden"
              :data-photo-id="item.photo.id"
              :style="{
                top: `${item.box.top}px`,
                left: `${item.box.left}px`,
                width: `${item.box.width}px`,
                height: `${item.box.height}px`,
              }"
            >
              <slot
                name="waterfall-card"
                :photo="item.photo"
                :index="item.index"
                :box-width="item.box.width"
                :box-height="item.box.height"
              />
            </div>
          </div>
        </section>
      </div>

      <div
        v-if="leadList.length && leadAtEnd"
        class="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8"
      >
        <div v-for="(lead, index) in leadList" :key="`end-${lead.id ?? lead.link ?? index}`">
          <slot name="lead" :lead="lead" variant="grid" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes switch-pulse {
  0% {
    transform: scale(0.8);
    opacity: 0.6;
  }
  70% {
    transform: scale(1.35);
    opacity: 0;
  }
  100% {
    transform: scale(1.35);
    opacity: 0;
  }
}
</style>