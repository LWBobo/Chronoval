<script lang="ts" setup>
const props = defineProps<{
  photoId: string
}>()

interface TagCatalogItem {
  id: number
  name: string
  enabled: boolean
}

interface Assignment {
  tagId: number
  name: string
  source: 'auto' | 'manual'
  decision: 'apply' | 'reject'
  score: number | null
}

const toast = useToast()
const { t } = useI18n()
const loading = ref(false)
const catalog = ref<TagCatalogItem[]>([])
const assignments = ref<Assignment[]>([])
const selectedTagId = ref<number | string | null>(null)

const applied = computed(() =>
  assignments.value.filter((item) => item.decision === 'apply'),
)
const rejected = computed(() =>
  assignments.value.filter((item) => item.decision === 'reject'),
)
const available = computed(() => {
  const used = new Set(
    assignments.value
      .filter((item) => item.decision === 'apply')
      .map((item) => item.tagId),
  )
  return catalog.value.filter((item) => !used.has(item.id))
})

const tagOptions = computed(() =>
  available.value.map((item) => ({ label: item.name, value: item.id })),
)

const addSelected = () => {
  const raw = selectedTagId.value
  const tagId = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(tagId) || tagId <= 0) return
  decide(tagId, 'apply')
}

const loadTags = async () => {
  if (!props.photoId) return
  loading.value = true
  try {
    const result = await $fetch<{
      assignments: Assignment[]
      catalog: TagCatalogItem[]
    }>(`/api/ml/photos/${props.photoId}/tags`)
    assignments.value = result.assignments
    catalog.value = result.catalog
  } catch (err: any) {
    toast.add({
      title: t('settings.ml.tags.photoTitle'),
      description: err?.data?.statusMessage || err?.message,
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}

const decide = async (
  tagId: number,
  action: 'apply' | 'reject' | 'clear',
) => {
  loading.value = true
  try {
    const result = await $fetch<{
      assignments: Assignment[]
      catalog: TagCatalogItem[]
    }>(`/api/ml/photos/${props.photoId}/tags`, {
      method: 'PUT',
      body: { tagId, action },
    })
    assignments.value = result.assignments
    catalog.value = result.catalog
    selectedTagId.value = null
  } catch (err: any) {
    toast.add({
      title: t('settings.ml.tags.photoTitle'),
      description: err?.data?.statusMessage || err?.message,
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}

watch(() => props.photoId, loadTags, { immediate: true })
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {{ $t('settings.ml.tags.photoTitle') }}
      </p>
    </div>
    <p class="text-xs text-neutral-500 dark:text-neutral-400">
      {{ $t('settings.ml.tags.photoHint') }}
      <NuxtLink
        to="/dashboard/settings/tags"
        class="text-neutral-700 underline dark:text-neutral-200"
      >
        {{ $t('title.tagSettings') }}
      </NuxtLink>
    </p>

    <div
      v-if="applied.length"
      class="flex flex-wrap gap-1.5"
    >
      <span
        v-for="item in applied"
        :key="item.tagId"
        class="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-xs text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
      >
        {{ item.name }}
        <span class="text-neutral-500">
          {{
            item.source === 'manual'
              ? $t('settings.ml.tags.manual')
              : $t('settings.ml.tags.auto')
          }}
        </span>
        <button
          type="button"
          class="text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
          :disabled="loading"
          @click="decide(item.tagId, item.source === 'auto' ? 'reject' : 'clear')"
        >
          ×
        </button>
      </span>
    </div>

    <div
      v-if="rejected.length"
      class="flex flex-wrap gap-1.5"
    >
      <span
        v-for="item in rejected"
        :key="item.tagId"
        class="inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-700"
      >
        {{ item.name }} · {{ $t('settings.ml.tags.rejected') }}
        <button
          type="button"
          class="hover:text-neutral-900 dark:hover:text-white"
          :disabled="loading"
          @click="decide(item.tagId, 'clear')"
        >
          {{ $t('settings.ml.tags.undo') }}
        </button>
      </span>
    </div>

    <div class="flex items-center gap-2">
      <USelectMenu
        v-model="selectedTagId"
        :items="tagOptions"
        value-key="value"
        label-key="label"
        class="min-w-0 flex-1"
        :placeholder="$t('settings.ml.tags.addPhotoTag')"
        :disabled="loading || tagOptions.length === 0"
        :search-input="tagOptions.length > 8"
        :ui="{ content: 'z-[400]' }"
      />
      <UButton
        size="sm"
        variant="soft"
        :disabled="loading || selectedTagId == null"
        @click="addSelected"
      >
        {{ $t('settings.ml.tags.add') }}
      </UButton>
    </div>
  </div>
</template>
