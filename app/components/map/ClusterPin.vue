<script lang="ts" setup>
import { motion } from 'motion-v'
import ThumbImage from '../ui/ThumbImage.vue'
import { twMerge } from 'tailwind-merge'
import type { ClusterPoint, PhotoMarker } from '~~/shared/types/map'

const props = withDefaults(
  defineProps<{
    clusterPoint: ClusterPoint
    clusterCount?: number
    markerId?: string
  }>(),
  {
    clusterCount: 6,
    markerId: undefined,
  },
)

const emit = defineEmits<{
  click: [clusterPoint: ClusterPoint]
  close: []
}>()

const dayjs = useDayjs()

const formatDateTaken = (value?: string) => {
  if (!value) return ''

  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : value
}

const previewOpen = ref(false)
const previewPhoto = ref<PhotoMarker | null>(null)

const openPreview = (photo: PhotoMarker) => {
  previewPhoto.value = photo
  previewOpen.value = true
}

const onPreviewOpen = (open: boolean) => {
  previewOpen.value = open
  if (!open) previewPhoto.value = null
}

const onClick = () => {
  emit('click', props.clusterPoint)
}

const clusteredPhotos = computed(
  () => props.clusterPoint.properties.clusteredPhotos || [],
)

const pointCount = computed(
  () => props.clusterPoint.properties.point_count || 1,
)

const representativePhoto = computed(
  () => props.clusterPoint.properties.marker!,
)

const sizeDelta = computed(() => {
  const count = pointCount.value
  return Math.min(64, Math.max(44, 32 + Math.log(count) * 10))
})

const mapThumbnailSrc = (photo: PhotoMarker, size = 256) => {
  const base = photo.mapThumbnailUrl
  if (!base) return photo.thumbnailUrl || ''
  return `${base}${base.includes('?') ? '&' : '?'}size=${size}`
}
</script>

<template>
  <MapProviderMarker
    :key="`marker-cluster-${representativePhoto.id}`"
    :marker-id="`marker-cluster-${markerId || representativePhoto.id}`"
    :lnglat="props.clusterPoint.geometry.coordinates"
  >
    <template #marker>
      <HoverCardRoot
        :open-delay="300"
        :close-delay="100"
        @close="$event.preventDefault()"
      >
        <HoverCardTrigger as-child>
          <motion.div
            class="relative group cursor-pointer"
            :initial="{ opacity: 0, scale: 0 }"
            :animate="{ opacity: 1, scale: 1 }"
            :while-hover="{ scale: 1.1 }"
            :while-press="{ scale: 0.95 }"
            :transition="{
              type: 'spring',
              stiffness: 400,
              damping: 30,
            }"
            @click="onClick"
          >
            <!-- Background image -->
            <div class="absolute inset-0 overflow-hidden rounded-full">
              <ThumbHash
                v-if="representativePhoto.thumbnailHash"
                :thumbhash="representativePhoto.thumbnailHash"
                class="absolute inset-0 size-full scale-110 opacity-70 blur-sm"
              />
              <div v-else class="absolute inset-0 bg-neutral-300/70 dark:bg-neutral-700/70" />
              <div
                class="absolute inset-0 bg-linear-to-br from-blue/40 to-purple/60 dark:from-blue/60 dark:to-purple/80"
              />
            </div>

            <!-- Cluster marker -->
            <div
              :class="
                twMerge(
                  'relative flex flex-col justify-center items-center rounded-full border shadow-lg hover:shadow-xl',
                  'border-white/50 bg-white/80 hover:bg-white/90 dark:border-white/30 dark:bg-black/60 dark:hover:bg-black/80',
                )
              "
              :style="{
                width: `${sizeDelta}px`,
                height: `${sizeDelta}px`,
              }"
            >
              <div
                class="absolute inset-0 rounded-full bg-linear-to-br from-white/10 to-white/5"
              />

              <!-- Cluster count -->
              <span
                class="text-neutral-800 dark:text-white text-sm font-bold drop-shadow leading-none"
              >
                {{ pointCount }}
              </span>

              <div
                class="absolute inset-0 rounded-full shadow-inner shadow-black/5"
              />
            </div>
          </motion.div>
        </HoverCardTrigger>
        <HoverCardPortal>
          <AnimatePresence>
            <HoverCardContent
              as-child
              side="top"
              align="center"
              :side-offset="8"
              update-position-strategy="always"
              sticky="always"
            >
              <motion.div
                class="bg-white/50 dark:bg-black/50 backdrop-blur-md border border-neutral-100 dark:border-neutral-700 rounded-lg shadow-lg w-xs max-w-xs overflow-hidden relative"
                :initial="{ opacity: 0, scale: 0.95, y: 4 }"
                :animate="{ opacity: 1, scale: 1, y: 0 }"
                :exit="{ opacity: 0, scale: 0.95, y: 4 }"
                :transition="{ duration: 0.2 }"
              >
                <!-- Cluster preview -->
                <div class="relative overflow-hidden p-3 space-y-3">
                  <div class="flex items-center justify-between">
                    <h3
                      class="text-sm font-semibold text-neutral-900 dark:text-white"
                    >
                      {{
                        $t('map.cluster.nearbyPhotos', [clusteredPhotos.length])
                      }}
                    </h3>
                    <div class="text-neutral-500 dark:text-muted text-[10px]">
                      {{ $t('map.cluster.previewHint') }}
                    </div>
                  </div>
                  <!-- Show grid of photos for cluster -->
                  <div class="grid grid-cols-3 gap-2 h-full">
                    <motion.div
                      v-for="(photo, index) in clusteredPhotos.slice(
                        0,
                        clusterCount,
                      )"
                      :key="photo.id"
                      :initial="{ opacity: 0, scale: 0.5 }"
                      :animate="{ opacity: 1, scale: 1 }"
                      :transition="{
                        delay: index * 0.05,
                        type: 'spring',
                        duration: 0.4,
                        bounce: 0,
                      }"
                      class="group"
                    >
                      <div class="relative overflow-hidden rounded">
                        <button
                          type="button"
                          class="block w-full cursor-zoom-in"
                          :aria-label="photo.title || $t('map.photo.altFallback', { id: photo.id })"
                          @click.stop="openPreview(photo)"
                        >
                          <ThumbImage
                            :src="mapThumbnailSrc(photo)"
                            :fallback-src="photo.thumbnailUrl"
                            :alt="photo.title || $t('map.photo.altFallback', { id: photo.id })"
                            :thumbhash="photo.thumbnailHash"
                            :lazy="false"
                            class="pointer-events-none aspect-square w-full object-cover"
                          />
                        </button>
                        <div
                          class="absolute inset-0 bg-white/30 dark:bg-black/20 duration-300 flex justify-center items-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                        >
                          <div
                            class="rounded-full bg-white/80 dark:bg-black/50 p-2 backdrop-blur-sm flex justify-center items-center"
                          >
                            <Icon
                              name="tabler:zoom-in"
                              class="text-neutral-700 dark:text-white"
                            />
                          </div>
                        </div>
                        <div
                          v-if="
                            index === clusterCount - 1 &&
                            clusteredPhotos.length > clusterCount
                          "
                          class="absolute inset-0 bg-white/80 dark:bg-black/60 flex items-center justify-center pointer-events-none"
                        >
                          <span
                            class="text-neutral-800 dark:text-white text-lg font-bold"
                          >
                            +{{ clusteredPhotos.length - clusterCount }}
                          </span>
                        </div>
                      </div>
                      <NuxtLink
                        :to="`/${photo.id}`"
                        target="_blank"
                        rel="noopener"
                        class="block truncate px-0.5 pt-0.5 text-[10px] leading-tight text-neutral-800 hover:underline dark:text-white"
                        @click.stop
                      >
                        {{ photo.title || $t('map.photo.altFallback', { id: photo.id }) }}
                      </NuxtLink>
                      <div
                        v-if="photo.dateTaken"
                        class="flex items-center gap-0.5 px-0.5 pt-0.5 text-[9px] leading-tight text-neutral-500 dark:text-neutral-400"
                      >
                        <Icon
                          name="tabler:calendar-time"
                          class="size-2.5 shrink-0"
                        />
                        <span class="truncate">
                          {{ formatDateTaken(photo.dateTaken) }}
                        </span>
                      </div>
                    </motion.div>
                  </div>
                  <MapPhotoLightbox
                    :open="previewOpen"
                    :src="previewPhoto?.thumbnailUrl"
                    :alt="
                      previewPhoto?.title ||
                      (previewPhoto
                        ? $t('map.photo.altFallback', { id: previewPhoto.id })
                        : '')
                    "
                    @update:open="onPreviewOpen"
                  />

                  <div class="relative space-y-1">
                    <!-- cities -->
                    <div
                      v-if="
                        clusteredPhotos.length &&
                        clusteredPhotos.some((p) => p.city)
                      "
                      class="flex items-center gap-1 text-xs text-neutral-600 dark:text-muted font-medium mt-2"
                    >
                      <Icon
                        name="tabler:map-pin"
                        class="size-4"
                      />
                      <span class="truncate">
                        {{
                          clusteredPhotos
                            .map((p) => p.city)
                            .filter((v, i, a) => v && a.indexOf(v) === i)
                            .join(', ')
                        }}
                      </span>
                    </div>
                    <!-- taken date range -->
                    <div
                      v-if="
                        clusteredPhotos.length &&
                        clusteredPhotos.some((p) => p.dateTaken)
                      "
                      class="flex items-center gap-1 text-xs text-neutral-600 dark:text-muted font-medium mt-2"
                    >
                      <Icon
                        name="tabler:calendar-week"
                        class="size-4"
                      />
                      <span class="truncate">
                        {{
                          (() => {
                            const dates = clusteredPhotos
                              .map((p) => p.dateTaken)
                              .filter(Boolean)
                              .sort()
                            if (dates.length === 0) return ''
                            if (dates.length === 1)
                              return dayjs(dates[0]).format('l')
                            return `${dayjs(dates[0]).format('l')} - ${dayjs(dates[dates.length - 1]).format('l')}`
                          })()
                        }}
                      </span>
                    </div>
                  </div>
                </div>
              </motion.div>
            </HoverCardContent>
          </AnimatePresence>
        </HoverCardPortal>
      </HoverCardRoot>
    </template>
  </MapProviderMarker>
</template>

<style scoped></style>
