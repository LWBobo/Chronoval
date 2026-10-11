<script setup lang="ts">
import { motion } from 'motion-v'

const { filteredPhotos, activeFilters, hasActiveFilters, clearAllFilters, clearFilterType, toggleFilter } = usePhotoFilters()

// 背景照片网格（最多 12 张）
const backgroundPhotos = computed(() =>
  filteredPhotos.value.slice(0, 12),
)

const headline = computed(() => {
  const c = filteredPhotos.value.length
  return $t('ui.activeFiltersHero.headline', { count: c }, c)
})

const resultCount = computed(() => filteredPhotos.value.length)

// 移除单个筛选 chip
function removeFilter(type: string, value?: string | number) {
  if (value !== undefined) {
    toggleFilter(type as any, value)
  } else {
    clearFilterType(type as any)
  }
}
</script>

<template>
  <motion.div
    :initial="{ opacity: 0, y: -20 }"
    :animate="{ opacity: 1, y: 0 }"
    :transition="{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }"
    class="relative left-1/2 w-screen -translate-x-1/2 overflow-hidden border-y border-white/5 bg-neutral-900 shadow-[0_25px_60px_rgba(0,0,0,0.35)]"
  >
    <!-- 背景铺在横幅内部，高度跟内容走，避免缩略图把时间轴顶出屏幕 -->
    <div class="absolute inset-0 grid grid-cols-4 grid-rows-3 gap-[2px]">
      <template v-if="backgroundPhotos.length">
        <img
          v-for="photo in backgroundPhotos"
          :key="photo.id"
          :src="photo.thumbnailUrl || photo.originalUrl"
          :alt="photo.title || ''"
          class="h-full w-full scale-105 object-cover"
          loading="lazy"
        />
      </template>
      <div
        v-for="n in Math.max(0, 12 - backgroundPhotos.length)"
        :key="`empty-${n}`"
        class="bg-linear-to-br from-zinc-900 via-black to-zinc-900"
      />
    </div>

    <!-- 暗色渐变覆盖 -->
    <div class="pointer-events-none absolute inset-0 bg-linear-to-b from-black/25 via-black/45 to-black/70" />

    <!-- 内容区 -->
    <div class="relative z-10 flex flex-col justify-end px-6 py-8 sm:px-10">
      <p
        v-if="hasActiveFilters"
        class="text-xs font-medium uppercase tracking-[0.5em] text-white/60"
      >
        {{ resultCount }} {{ $t('ui.activeFiltersHero.results') }}
      </p>
      <h2 class="mt-3 text-4xl font-semibold text-white drop-shadow-[0_15px_30px_rgba(0,0,0,0.65)] lg:text-5xl">
        {{ headline }}
      </h2>

      <!-- 筛选 chips -->
      <div class="mt-6 flex w-full flex-wrap items-center gap-2">
        <span
          v-for="tag in activeFilters.tags"
          :key="`tag-${tag}`"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition-colors hover:bg-white/15 hover:text-white"
          @click="removeFilter('tags', tag)"
        >
          {{ tag }}
          <Icon name="tabler:x" class="size-3 text-white/50" />
        </span>
        <span
          v-for="camera in activeFilters.cameras"
          :key="`camera-${camera}`"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition-colors hover:bg-white/15 hover:text-white"
          @click="removeFilter('cameras', camera)"
        >
          {{ camera }}
          <Icon name="tabler:x" class="size-3 text-white/50" />
        </span>
        <span
          v-for="lens in activeFilters.lenses"
          :key="`lens-${lens}`"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition-colors hover:bg-white/15 hover:text-white"
          @click="removeFilter('lenses', lens)"
        >
          {{ lens }}
          <Icon name="tabler:x" class="size-3 text-white/50" />
        </span>
        <span
          v-for="city in activeFilters.cities"
          :key="`city-${city}`"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition-colors hover:bg-white/15 hover:text-white"
          @click="removeFilter('cities', city)"
        >
          {{ city }}
          <Icon name="tabler:x" class="size-3 text-white/50" />
        </span>
        <span
          v-if="activeFilters.ratings > 0"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition-colors hover:bg-white/15 hover:text-white"
          @click="clearFilterType('ratings')"
        >
          <Icon name="tabler:star-filled" class="size-3 text-amber-400" />
          {{ activeFilters.ratings }}+
          <Icon name="tabler:x" class="size-3 text-white/50" />
        </span>
        <span
          v-if="activeFilters.search"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition-colors hover:bg-white/15 hover:text-white"
          @click="clearFilterType('search')"
        >
          <Icon name="tabler:search" class="size-3 text-white/60" />
          {{ $t('ui.activeFiltersHero.search') }} “{{ activeFilters.search }}”
          <Icon name="tabler:x" class="size-3 text-white/50" />
        </span>
      </div>

      <!-- 操作按钮 -->
      <div class="mt-8 flex items-center gap-3">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full border border-white/15 px-5 py-2.5 text-sm font-medium text-white/90 backdrop-blur-sm transition-all hover:border-white/25 hover:bg-white/10 hover:text-white active:scale-95"
          @click="clearAllFilters"
        >
          <Icon name="tabler:x" class="size-4" />
          {{ $t('ui.activeFiltersHero.clearAll') }}
        </button>
      </div>
    </div>
  </motion.div>
</template>

<style scoped></style>