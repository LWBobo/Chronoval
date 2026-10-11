<script lang="ts" setup>
import { motion } from 'motion-v'

const props = withDefaults(
  defineProps<{
    photo: Photo
    index: number
    hasAnimated: boolean
    firstScreenItems?: number
    columnWidth?: number
    boxWidth?: number
    boxHeight?: number
  }>(),
  {
    firstScreenItems: 30,
    columnWidth: 250,
  },
)

const fillMode = computed(
  () =>
    props.boxWidth != null &&
    props.boxHeight != null &&
    props.boxWidth > 0 &&
    props.boxHeight > 0,
)

const emit = defineEmits<{
  animationComplete: []
  'visibility-change': [
    { index: number; isVisible: boolean; date: string | Date },
  ]
  openViewer: [number]
}>()

const itemKey = computed(() => {
  return props.photo.id
})

const shouldAnimate = computed(() => {
  return !props.hasAnimated && props.index < props.firstScreenItems
})

const animateDelay = computed(() => {
  return props.index * 0.02
})

const itemVariants = {
  hidden: {
    opacity: 0,
    y: 24,
    scale: 0.96,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring' as const,
      duration: 0.3,
      bounce: 0,
      delay: animateDelay.value,
    },
  },
}
</script>

<template>
  <motion.div
    :key="itemKey"
    :data-photo-id="photo.id"
    :variants="shouldAnimate ? itemVariants : undefined"
    :initial="shouldAnimate ? 'hidden' : 'visible'"
    :animate="'visible'"
    :class="fillMode ? 'h-full w-full' : 'w-full'"
    @animation-complete="
      () => {
        if (shouldAnimate) emit('animationComplete')
      }
    "
  >
    <MasonryItemPhoto
      :photo="photo"
      :index="index"
      :column-width="boxWidth || columnWidth"
      :box-width="boxWidth"
      :box-height="boxHeight"
      @visibility-change="emit('visibility-change', $event)"
      @open-viewer="emit('openViewer', $event)"
    />
  </motion.div>
</template>

<style scoped></style>
