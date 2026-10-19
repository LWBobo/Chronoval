<script setup lang="ts">
definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: () => $t('title.watermark'),
})

interface WatermarkHit {
  mount: string
  mountName: string
  relPath: string
  fileName: string
  size: number
  mtime: string
  brand: string
}

interface RemoveResult {
  mount: string
  relPath: string
  ok: boolean
  code?: string
  message?: string
}

const toast = useToast()
const scanning = ref(false)
const clearing = ref(false)
const confirmOpen = ref(false)
const scanned = ref(0)
const mountCount = ref(0)
const unavailable = ref<string[]>([])
const items = ref<WatermarkHit[]>([])
const selected = ref<string[]>([])
const results = ref<Record<string, RemoveResult>>({})

const keyOf = (item: { mount: string; relPath: string }) =>
  `${item.mount}\n${item.relPath}`

const allSelected = computed(
  () => items.value.length > 0 && selected.value.length === items.value.length,
)

const formatSize = (size: number) => {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const isSelected = (item: WatermarkHit) => selected.value.includes(keyOf(item))

const toggle = (item: WatermarkHit, checked: boolean) => {
  const key = keyOf(item)
  if (checked) {
    if (!selected.value.includes(key)) selected.value = [...selected.value, key]
    return
  }
  selected.value = selected.value.filter((entry) => entry !== key)
}

const toggleAll = (checked: boolean) => {
  selected.value = checked ? items.value.map((item) => keyOf(item)) : []
}

const scan = async () => {
  scanning.value = true
  try {
    const data = await $fetch('/api/watermark/scan', { method: 'POST' })
    items.value = data.items
    scanned.value = data.scanned
    mountCount.value = data.mounts
    unavailable.value = data.unavailable
    selected.value = []
    results.value = {}
    toast.add({
      title: $t('dashboard.watermark.scanDone'),
      description: $t('dashboard.watermark.scanDoneDescription', {
        count: data.items.length,
      }),
      color: 'success',
    })
  } catch (error: any) {
    toast.add({
      title: $t('dashboard.watermark.scanFailed'),
      description: error?.data?.message || error?.message,
      color: 'error',
    })
  } finally {
    scanning.value = false
  }
}

const clearSelected = async () => {
  const chosen = items.value.filter((item) => isSelected(item))
  if (!chosen.length) return
  confirmOpen.value = false
  clearing.value = true
  let cleaned = 0
  let failed = 0
  try {
    const chunkSize = 20
    for (let index = 0; index < chosen.length; index += chunkSize) {
      const chunk = chosen.slice(index, index + chunkSize)
      const data = await $fetch('/api/watermark/remove', {
        method: 'POST',
        body: {
          files: chunk.map((item) => ({
            mount: item.mount,
            relPath: item.relPath,
          })),
        },
      })
      const nextResults = { ...results.value }
      const failedKeys = new Set<string>()
      for (const result of data.results as RemoveResult[]) {
        const key = keyOf(result)
        nextResults[key] = result
        if (!result.ok) failedKeys.add(key)
      }
      results.value = nextResults
      cleaned += data.cleaned
      failed += data.failed
      const chunkKeys = new Set(chunk.map((item) => keyOf(item)))
      items.value = items.value.filter((item) => {
        const key = keyOf(item)
        return !chunkKeys.has(key) || failedKeys.has(key)
      })
      selected.value = items.value
        .map((item) => keyOf(item))
        .filter((key) => selected.value.includes(key))
    }
    toast.add({
      title: $t('dashboard.watermark.clearDone'),
      description: $t('dashboard.watermark.clearDoneDescription', {
        cleaned,
        failed,
      }),
      color: failed ? 'warning' : 'success',
    })
  } catch (error: any) {
    toast.add({
      title: $t('dashboard.watermark.clearFailed'),
      description: error?.data?.message || error?.message,
      color: 'error',
    })
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <UContainer class="py-6 space-y-6">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div class="space-y-2 max-w-3xl">
        <h1 class="text-2xl font-semibold">
          {{ $t('dashboard.watermark.title') }}
        </h1>
        <p class="text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
          {{ $t('dashboard.watermark.description') }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <UButton
          icon="tabler:search"
          variant="soft"
          :loading="scanning"
          :disabled="clearing"
          @click="scan"
        >
          {{ $t('dashboard.watermark.scan') }}
        </UButton>
        <UButton
          icon="tabler:eraser"
          color="error"
          :loading="clearing"
          :disabled="scanning || selected.length === 0"
          @click="confirmOpen = true"
        >
          {{ $t('dashboard.watermark.clear') }}
        </UButton>
      </div>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <DashboardIndicator
        :title="$t('dashboard.watermark.stats.mounts')"
        icon="tabler:folder"
        color="blue"
        :value="mountCount"
      />
      <DashboardIndicator
        :title="$t('dashboard.watermark.stats.scanned')"
        icon="tabler:photo"
        color="orange"
        :value="scanned"
      />
      <DashboardIndicator
        :title="$t('dashboard.watermark.stats.found')"
        icon="tabler:badge"
        color="green"
        :value="items.length"
      />
      <DashboardIndicator
        :title="$t('dashboard.watermark.stats.selected')"
        icon="tabler:checks"
        color="red"
        :value="selected.length"
      />
    </div>

    <UAlert
      v-if="unavailable.length"
      color="warning"
      variant="soft"
      icon="tabler:alert-triangle"
      :title="$t('dashboard.watermark.unavailable')"
      :description="unavailable.join(', ')"
    />

    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <UCheckbox
            :model-value="allSelected"
            :disabled="items.length === 0 || clearing"
            :label="$t('dashboard.watermark.selectAll')"
            @update:model-value="toggleAll(Boolean($event))"
          />
          <span class="text-sm text-neutral-500">
            {{ $t('dashboard.watermark.selectedCount', { count: selected.length }) }}
          </span>
        </div>
      </template>

      <div
        v-if="items.length === 0"
        class="py-16 text-center text-sm text-neutral-500"
      >
        {{ scanning ? $t('dashboard.watermark.scanning') : $t('dashboard.watermark.empty') }}
      </div>

      <div
        v-else
        class="max-h-[32rem] divide-y divide-neutral-200 overflow-y-auto dark:divide-neutral-800"
      >
        <div
          v-for="item in items"
          :key="keyOf(item)"
          class="flex cursor-pointer items-start gap-3 px-1 py-3"
          @click="toggle(item, !isSelected(item))"
        >
          <UCheckbox
            :model-value="isSelected(item)"
            :disabled="clearing"
            class="mt-0.5"
            @click.stop
            @update:model-value="toggle(item, Boolean($event))"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ item.fileName }}</span>
            <span class="block truncate text-xs text-neutral-500">
              {{ item.mountName }} / {{ item.relPath }}
              · {{ $t(`dashboard.watermark.brands.${item.brand}`) }}
            </span>
            <span
              v-if="results[keyOf(item)] && !results[keyOf(item)]?.ok"
              class="mt-1 block text-xs text-error-500"
            >
              {{ results[keyOf(item)]?.message }}
            </span>
          </span>
          <span class="shrink-0 text-xs text-neutral-500">{{ formatSize(item.size) }}</span>
        </div>
      </div>
    </UCard>

    <UModal v-model:open="confirmOpen">
      <template #body>
        <div class="space-y-4">
          <div class="flex items-start gap-4">
            <div
              class="flex size-10 shrink-0 items-center justify-center rounded-full bg-error-100 text-error-600 dark:bg-error-900/40 dark:text-error-400"
            >
              <Icon
                name="tabler:eraser"
                class="size-6"
              />
            </div>
            <div class="space-y-1.5 pt-1">
              <h3 class="text-lg font-semibold leading-5">
                {{ $t('dashboard.watermark.confirmTitle') }}
              </h3>
              <p class="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                {{ $t('dashboard.watermark.confirmBody', { count: selected.length }) }}
              </p>
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <UButton
              variant="ghost"
              @click="confirmOpen = false"
            >
              {{ $t('dashboard.watermark.cancel') }}
            </UButton>
            <UButton
              color="error"
              icon="tabler:eraser"
              @click="clearSelected"
            >
              {{ $t('dashboard.watermark.confirm') }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>
