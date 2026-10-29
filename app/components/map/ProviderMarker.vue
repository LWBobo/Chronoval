<script lang="ts" setup>
withDefaults(
  defineProps<{
    markerId?: string
    lnglat?: [number, number]
  }>(),
  {
    markerId: undefined,
    lnglat: undefined,
  },
)

const mapConfig = computed(() => {
  const config = getSetting('map')
  return typeof config === 'object' && config ? config : {}
})

const provider = computed(() => mapConfig.value.provider || 'maplibre')
</script>

<template>
  <LazyMapboxDefaultMarker
    v-if="provider === 'mapbox'"
    :marker-id
    :lnglat
  >
    <template #marker>
      <slot name="marker" />
    </template>
  </LazyMapboxDefaultMarker>
  <MglMarker
    v-else
    :coordinates="lnglat"
  >
    <template #marker>
      <slot name="marker" />
    </template>
  </MglMarker>
</template>

<style scoped></style>
