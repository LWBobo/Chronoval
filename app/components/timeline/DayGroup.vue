<script lang="ts" setup>
import type { TimelineDayGroup } from '~/utils/timeline'
import { getTimelineHeaderHeight } from '~/utils/timeline'

const props = defineProps<{
  group: TimelineDayGroup
  isMobile: boolean
  /** Only mount photo cards when near viewport (virtualization) */
  active?: boolean
}>()

const emit = defineEmits<{
  'open-viewer': [index: number]
  'visibility-change': [
    { index: number; isVisible: boolean; date: string | Date },
  ]
}>()

const headerHeight = computed(() => getTimelineHeaderHeight(props.isMobile))

const citiesLabel = computed(() => {
  const cities = props.group.cities
  if (cities.length === 0) return ''
  if (cities.length <= 2) return cities.join(' · ')
  return `${cities.slice(0, 2).join(' · ')} +${cities.length - 2}`
})
</script>

<template>
  <section
    class="timeline-day absolute left-0 w-full"
    :data-day-key="group.key"
    :style="{
      top: `${group.top}px`,
      height: `${group.height}px`,
    }"
  >
    <!-- Day header -->
    <header
      class="flex items-baseline gap-2 px-1 sm:px-2"
      :style="{ height: `${headerHeight}px` }"
    >
      <h2
        class="text-sm font-semibold tracking-wide text-neutral-800 dark:text-neutral-100 sm:text-base"
      >
        {{ group.title }}
      </h2>
      <span
        v-if="citiesLabel"
        class="truncate text-xs text-neutral-500 dark:text-neutral-400"
      >
        {{ citiesLabel }}
      </span>
      <span class="ml-auto shrink-0 text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
        {{ group.photos.length }}
      </span>
    </header>

    <!-- Justified photo grid -->
    <div
      class="relative w-full"
      :style="{ height: `${group.contentHeight}px` }"
    >
      <template v-if="active !== false">
        <div
          v-for="item in group.photos"
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
          <MasonryItemPhoto
            :photo="item.photo"
            :index="item.index"
            :column-width="item.box.width"
            :box-width="item.box.width"
            :box-height="item.box.height"
            class="h-full w-full"
            @visibility-change="emit('visibility-change', $event)"
            @open-viewer="emit('open-viewer', $event)"
          />
        </div>
      </template>
      <div
        v-else
        class="absolute inset-0 animate-pulse rounded-sm bg-neutral-200/40 dark:bg-neutral-800/40"
        aria-hidden="true"
      />
    </div>
  </section>
</template>
