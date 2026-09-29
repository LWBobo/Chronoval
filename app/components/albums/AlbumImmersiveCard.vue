<script lang="ts" setup>
/**
 * 沉浸式看图卡片：单列、每张照片占满卡片宽度，高度按原始长宽比自适应。
 * 优先加载原图（沉浸看图要清晰），缩略图仅作失败回退。
 * 向下滚动即可逐张全宽浏览，类似看图软件。
 */
const props = defineProps<{
  photo: {
    id: string
    thumbnailUrl?: string | null
    thumbnailHash?: string | null
    originalUrl?: string | null
    aspectRatio?: number | null
    width?: number | null
    height?: number | null
    [key: string]: any
  }
  index: number
}>()

const emit = defineEmits<{ open: [index: number] }>()

const aspectRatio = computed(() => {
  if (props.photo.aspectRatio) return props.photo.aspectRatio
  if (props.photo.width && props.photo.height)
    return props.photo.width / props.photo.height
  return 4 / 3
})

// 给 content-visibility 提供固有高度，避免滚动跳动
const intrinsicSize = computed(() => {
  // 以桌面端中等内容宽度估算固有高度
  const height = Math.round(720 / aspectRatio.value)
  return Math.max(height, 120)
})
</script>

<template>
  <div
    class="photo-card group relative mx-auto w-full max-w-4xl cursor-zoom-in overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-neutral-900/5 dark:ring-white/5 xl:max-w-5xl 2xl:max-w-6xl"
    :style="{ 'contain-intrinsic-size': `auto ${intrinsicSize}px` }"
    @click="emit('open', index)"
  >
    <div class="flex w-full items-center justify-center sm:max-h-[85vh]" :style="{ aspectRatio }">
      <!-- 沉浸看图：主图为原图，缩略图作为失败回退 -->
      <!-- 视频：原图为视频文件无法直接渲染，走服务端缩略图/浏览器首帧兜底 -->
      <AlbumsVideoThumb
        v-if="photo.type === 'video'"
        :video-src="photo.originalUrl || ''"
        :poster="photo.thumbnailUrl || null"
        :thumbhash="photo.thumbnailHash || ''"
        :alt="photo.id"
        image-contain
        class="absolute inset-0 h-full w-full object-contain"
      />
      <ThumbImage
        v-else
        :src="photo.originalUrl || photo.thumbnailUrl || ''"
        :fallback-src="photo.thumbnailUrl || ''"
        :alt="photo.id"
        :thumbhash="photo.thumbnailHash || ''"
        class="absolute inset-0 h-full w-full object-contain"
      />
      <!-- 视频标识：提示该卡片为可播放的视频文件 -->
      <div
        v-if="photo.type === 'video'"
        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10"
      >
        <span class="flex size-12 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
          <Icon name="tabler:player-play" class="size-6 ml-0.5" />
        </span>
      </div>
      <!-- GIF 标识：右上角动图标签 -->
      <span
        v-if="isGifPhoto(photo)"
        class="pointer-events-none absolute right-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white backdrop-blur-sm"
      >
        GIF
      </span>
    </div>
  </div>
</template>

<style scoped>
.photo-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
  isolation: isolate;
}
</style>