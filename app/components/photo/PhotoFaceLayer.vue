<script lang="ts" setup>
import FaceOverlay from './FaceOverlay.vue'
const props = defineProps<{
  photoId: string
  imageWidth?: number | null
  imageHeight?: number | null
  hidden?: boolean
}>()

const root = ref<HTMLElement | null>(null)
const box = ref({
  left: '0px',
  top: '0px',
  width: '100%',
  height: '100%',
})

let observer: ResizeObserver | null = null

function layout() {
  const parent = root.value?.parentElement
  const iw = props.imageWidth || 0
  const ih = props.imageHeight || 0
  if (!parent || iw <= 0 || ih <= 0) {
    box.value = { left: '0px', top: '0px', width: '100%', height: '100%' }
    return
  }
  const cw = parent.clientWidth
  const ch = parent.clientHeight
  if (cw <= 0 || ch <= 0) return
  const scale = Math.min(cw / iw, ch / ih)
  const w = iw * scale
  const h = ih * scale
  box.value = {
    left: `${(cw - w) / 2}px`,
    top: `${(ch - h) / 2}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
}

onMounted(() => {
  layout()
  const parent = root.value?.parentElement
  if (!parent || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => layout())
  observer.observe(parent)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(
  () => [props.photoId, props.imageWidth, props.imageHeight, props.hidden],
  () => nextTick(layout),
)
</script>

<template>
  <div
    v-show="!hidden"
    ref="root"
    class="pointer-events-none absolute inset-0 z-30"
  >
    <div
      class="pointer-events-none absolute"
      :style="box"
    >
      <FaceOverlay
        :photo-id="photoId"
        visible
      />
    </div>
  </div>
</template>
