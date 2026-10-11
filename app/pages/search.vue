<script lang="ts" setup>
useHead({
  title: () => $t('title.search'),
})

interface SmartHit {
  photoId: string
  score: number
  distance: number
  source: 'clip' | 'ocr'
}

interface AlbumOption {
  id: number
  title?: string | null
}

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { status: photosStatus, getPhotoById } = usePhotos()
const { activeFilters, hasActiveFilters } = usePhotoFilters()

const queryText = ref(String(route.query.q || ''))
const mode = ref<'all' | 'clip' | 'ocr'>('all')
const dateFrom = ref('')
const dateTo = ref('')
const albumId = ref<number | ''>('')
const loading = ref(false)
const errorMsg = ref<string | null>(null)
const hits = ref<SmartHit[]>([])
const searched = ref(false)

const { data: albumPayload } = useFetch<AlbumOption[]>('/api/albums')
const albums = computed(() =>
  (albumPayload.value || []).filter(
    (album) => typeof album.id === 'number' && album.title,
  ),
)

function photoDay(value?: string | null) {
  return (value || '').slice(0, 10)
}

const resultPhotos = computed(() => {
  return hits.value
    .map((hit) => {
      const cached = getPhotoById(hit.photoId)
      return {
        ...hit,
        photo: cached || null,
      }
    })
    .filter((item) => {
      const photo = item.photo
      if (!photo?.thumbnailUrl) return false
      if (!photoMatchesFacets(photo, activeFilters.value)) return false
      const day = photoDay(photo.dateTaken)
      if ((dateFrom.value || dateTo.value) && !day) return false
      if (dateFrom.value && day < dateFrom.value) return false
      if (dateTo.value && day > dateTo.value) return false
      return true
    })
})

const showEmpty = computed(
  () =>
    searched.value &&
    !loading.value &&
    photosStatus.value !== 'pending' &&
    resultPhotos.value.length === 0 &&
    !errorMsg.value,
)

async function runSearch(q?: string) {
  const text = (q ?? queryText.value).trim()
  queryText.value = text
  errorMsg.value = null
  searched.value = true

  if (!text) {
    hits.value = []
    return
  }

  loading.value = true
  try {
    await router.replace({ query: { q: text } })
    const res = await $fetch<{ query: string; results: SmartHit[] }>(
      '/api/search/smart',
      {
        method: 'POST',
        body: {
          q: text,
          limit: 50,
          mode: mode.value,
          dateFrom: dateFrom.value || undefined,
          dateTo: dateTo.value || undefined,
          cameras: activeFilters.value.cameras,
          lenses: activeFilters.value.lenses,
          cities: activeFilters.value.cities,
          tags: activeFilters.value.tags,
          minRating: activeFilters.value.ratings || undefined,
          albumId: albumId.value === '' ? undefined : Number(albumId.value),
        },
      },
    )
    hits.value = res.results || []
  } catch (err: any) {
    hits.value = []
    errorMsg.value = err?.data?.message || err?.message || t('ui.search.failed')
  } finally {
    loading.value = false
  }
}

watch(
  () => String(route.query.q || ''),
  (text) => {
    if (text === queryText.value && (searched.value || !text)) return
    queryText.value = text
    if (text) runSearch(text)
    else {
      hits.value = []
      searched.value = false
    }
  },
)

watch(
  activeFilters,
  () => {
    if (searched.value && queryText.value.trim()) runSearch()
  },
  { deep: true },
)

onMounted(() => {
  if (queryText.value) runSearch(queryText.value)
})
</script>

<template>
  <div class="relative min-h-svh">
    <div
      class="page-backdrop pointer-events-none fixed inset-0 -z-10"
      aria-hidden="true"
    />
    <AppTopHeader />

    <div class="mx-auto w-full max-w-6xl px-4 pt-16 pb-20">
      <form
        class="flex flex-col gap-3"
        @submit.prevent="runSearch()"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <UInput
            v-model="queryText"
            size="lg"
            icon="tabler:search"
            class="flex-1"
            :placeholder="$t('ui.search.smartPlaceholder')"
            autofocus
          />
          <UButton
            type="submit"
            size="lg"
            icon="tabler:search"
            :loading="loading"
          >
            {{ $t('title.search') }}
          </UButton>
          <OverlayFilterPanel />
        </div>

        <div class="flex flex-wrap items-center gap-2 text-sm">
          <select
            v-model="mode"
            class="rounded-md border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="all">
              {{ $t('ui.search.modeAll') }}
            </option>
            <option value="clip">
              {{ $t('ui.search.modeClip') }}
            </option>
            <option value="ocr">
              {{ $t('ui.search.modeOcr') }}
            </option>
          </select>
          <input
            v-model="dateFrom"
            type="date"
            class="rounded-md border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            :aria-label="$t('ui.search.dateFrom')"
          />
          <input
            v-model="dateTo"
            type="date"
            class="rounded-md border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            :aria-label="$t('ui.search.dateTo')"
          />
          <select
            v-model="albumId"
            class="max-w-xs rounded-md border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">
              {{ $t('ui.search.anyAlbum') }}
            </option>
            <option
              v-for="album in albums"
              :key="album.id"
              :value="album.id"
            >
              {{ album.title }}
            </option>
          </select>
          <span
            v-if="hasActiveFilters"
            class="text-neutral-500"
          >
            {{ $t('ui.search.facetsApplied') }}
          </span>
        </div>
      </form>

      <p
        v-if="errorMsg"
        class="mt-4 text-sm text-error-600 dark:text-error-400"
      >
        {{ errorMsg }}
      </p>

      <div
        v-else-if="loading || (searched && photosStatus === 'pending')"
        class="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      >
        <USkeleton
          v-for="i in 10"
          :key="i"
          class="aspect-square w-full rounded-md"
        />
      </div>

      <p
        v-else-if="showEmpty"
        class="mt-8 text-center text-sm text-neutral-500"
      >
        {{ $t('ui.search.empty') }}
      </p>

      <div
        v-if="resultPhotos.length"
        class="mt-8 columns-2 gap-2 sm:columns-3 md:columns-4 lg:columns-5"
      >
        <NuxtLink
          v-for="item in resultPhotos"
          :key="item.photoId"
          :to="`/${item.photoId}`"
          class="relative mb-2 block break-inside-avoid overflow-hidden rounded-md"
        >
          <ThumbImage
            :src="item.photo!.thumbnailUrl || ''"
            :thumbhash="item.photo!.thumbnailHash"
            :alt="item.photo!.title || item.photoId"
            class="w-full"
            :style="{
              aspectRatio: String(item.photo!.aspectRatio || 1),
            }"
          />
          <span
            v-if="item.source === 'ocr'"
            class="absolute top-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white"
          >
            {{ $t('ui.search.ocrHit') }}
          </span>
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-backdrop {
  background:
    radial-gradient(
      ellipse 80% 50% at 50% -10%,
      rgba(120, 140, 180, 0.12),
      transparent 70%
    ),
    linear-gradient(to bottom, #f8f9fb, #eef1f5);
}
:global(html.dark) .page-backdrop {
  background:
    radial-gradient(
      ellipse 80% 50% at 50% -10%,
      rgba(80, 100, 140, 0.18),
      transparent 70%
    ),
    linear-gradient(to bottom, #0c0c10, #121218);
}
</style>
