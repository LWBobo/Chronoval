<script lang="ts" setup>
import type { ScanPhoto } from '~/components/albums/scanPhoto'

/**
 * 子相簿格子：尺寸与同布局的照片格一致，排在父相簿照片之前。
 * 封面用子相簿第一张照片，底部标出文件夹名和张数。
 */
const props = defineProps<{
  child: {
    title: string
    link: string
    photoCount: number
    passwordProtected?: boolean
    covers: ScanPhoto[]
  }
  variant: 'waterfall' | 'grid' | 'immersive'
}>()

const cover = computed(() => props.child.covers?.[0])

const aspectRatio = computed(() => {
  if (props.variant === 'grid') return 4 / 3
  return cover.value?.aspectRatio || 4 / 3
})

const intrinsicSize = computed(() => {
  const width = props.variant === 'immersive' ? 720 : 280
  return Math.max(Math.round(width / aspectRatio.value), 100)
})
</script>

<template>
  <NuxtLink
    :to="child.link"
    class="photo-card group relative block w-full overflow-hidden bg-neutral-900"
    :class="
      variant === 'grid'
        ? 'aspect-[4/3]'
        : variant === 'immersive'
          ? 'mx-auto max-w-4xl rounded-lg ring-1 ring-neutral-900/5 xl:max-w-5xl 2xl:max-w-6xl dark:ring-white/5'
          : ''
    "
    :style="
      variant === 'grid'
        ? undefined
        : { 'contain-intrinsic-size': `auto ${intrinsicSize}px` }
    "
    :aria-label="child.title"
  >
    <div
      class="w-full"
      :class="variant === 'grid' ? 'absolute inset-0' : ''"
      :style="variant === 'grid' ? undefined : { aspectRatio }"
    >
      <ThumbImage
        v-if="cover"
        :src="cover.thumbnailUrl || cover.originalUrl || ''"
        :fallback-src="cover.originalUrl || ''"
        :alt="child.title"
        :thumbhash="cover.thumbnailHash || ''"
        class="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
      />
      <div
        v-else
        class="absolute inset-0 flex items-center justify-center bg-neutral-800 text-neutral-400"
      >
        <Icon name="tabler:folder-heart" class="size-8" />
      </div>
    </div>

    <Icon
      v-if="child.passwordProtected"
      name="tabler:lock"
      class="absolute right-2 top-2 size-4 text-white drop-shadow"
    />

    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-2 pb-1.5 pt-8"
    >
      <p class="flex min-w-0 items-center gap-1 text-[12px] font-medium text-white">
        <Icon name="tabler:folder-heart" class="size-3.5 shrink-0" />
        <span class="truncate">{{ child.title }}</span>
      </p>
      <span class="shrink-0 text-[11px] tabular-nums text-white/90">
        {{ child.photoCount }}
      </span>
    </div>
  </NuxtLink>
</template>

<style scoped>
.photo-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
  isolation: isolate;
}
</style>
