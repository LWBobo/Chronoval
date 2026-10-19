<script lang="ts" setup>
const open = defineModel<boolean>('open', { default: false })

defineProps<{
  src?: string
  alt: string
}>()

const close = () => {
  open.value = false
}

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') close()
}

watch(open, (value) => {
  if (!import.meta.client) return
  if (value) window.addEventListener('keydown', onKeydown)
  else window.removeEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  if (import.meta.client) window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && src"
      class="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 cursor-zoom-out"
      @pointerdown.stop
      @click.stop="close"
    >
      <img
        :src="src"
        :alt="alt"
        draggable="false"
        class="pointer-events-none max-h-[86vh] max-w-[min(94vw,64rem)] object-contain select-none"
      />
    </div>
  </Teleport>
</template>
