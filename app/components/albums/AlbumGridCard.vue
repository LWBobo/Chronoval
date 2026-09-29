<script lang="ts" setup>
/**
 * 统一网格卡片：固定 4:3 宽高比、图片 object-cover 铺满，各卡片等高整齐排列。
 * 用于「统一网格」布局。点击触发 open(index)。
 */
defineProps<{
  photo: {
    id: string
    thumbnailUrl?: string | null
    thumbnailHash?: string | null
    originalUrl?: string | null
    [key: string]: any
  }
  index: number
}>()

const emit = defineEmits<{ open: [index: number] }>()
</script>

<template>
  <button
    type="button"
    class="photo-card group relative block aspect-[4/3] w-full cursor-zoom-in overflow-hidden bg-neutral-900 outline-offset-[-2px] transition-transform duration-300 focus-visible:outline-2 focus-visible:outline-accent"
    :aria-label="photo.id"
    @click="emit('open', index)"
  >
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
    <!-- GIF 标识：右上角动图标签 -->
    <span
      v-if="isGifPhoto(photo)"
      class="pointer-events-none absolute right-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white backdrop-blur-sm"
    >
      GIF
    </span>
  </button>
</template>

<style scoped>
/* 性能：跳过屏幕外卡片绘制，避免大图库滚动卡顿 */
.photo-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
  isolation: isolate;
}
</style>