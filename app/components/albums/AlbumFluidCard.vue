<script lang="ts" setup>
/**
 * 瀑布流简约卡片：高度按照片原始长宽比自动适配（适合外部库相簿等无丰富元数据的场景）。
 * 用于「瀑布流」布局。点击触发 open(index)。
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
  columnWidth?: number
}>()

const emit = defineEmits<{ open: [index: number] }>()

const aspectRatio = computed(() => {
  if (props.photo.aspectRatio) return props.photo.aspectRatio
  if (props.photo.width && props.photo.height)
    return props.photo.width / props.photo.height
  return 4 / 3
})

// 给 content-visibility 提供正确固有高度，避免滚动跳动
const intrinsicSize = computed(() => {
  const height = Math.round((props.columnWidth || 280) / aspectRatio.value)
  return Math.max(height, 100)
})
</script>

<template>
  <div
    class="photo-card group relative w-full cursor-zoom-in overflow-hidden bg-neutral-900"
    :style="{ 'contain-intrinsic-size': `auto ${intrinsicSize}px` }"
    @click="emit('open', index)"
  >
    <div class="w-full" :style="{ aspectRatio }">
      <!-- 视频：优先服务端缩略图，缺失/失败时用浏览器抽取首帧兜底 -->
      <AlbumsVideoThumb
        v-if="photo.type === 'video'"
        :video-src="photo.originalUrl || ''"
        :poster="photo.thumbnailUrl || null"
        :thumbhash="photo.thumbnailHash || ''"
        :alt="photo.id"
        class="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
      />
      <ThumbImage
        v-else
        :src="photo.thumbnailUrl || photo.originalUrl || ''"
        :fallback-src="photo.originalUrl || ''"
        :alt="photo.id"
        :thumbhash="photo.thumbnailHash || ''"
        class="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
      />
      <!-- 视频标识：提示该卡片为可播放的视频文件 -->
      <div
        v-if="photo.type === 'video'"
        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10"
      >
        <span class="flex size-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
          <Icon name="tabler:player-play" class="size-5 ml-0.5" />
        </span>
      </div>
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