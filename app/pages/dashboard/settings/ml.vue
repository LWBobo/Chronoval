<script lang="ts" setup>
definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: () => $t('title.mlSettings'),
})

const {
  fields: mlFields,
  state: mlState,
  submit: submitMl,
  loading: mlLoading,
} = useSettingsForm('ml')

const sameValue = (left: any, right: any) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const isMlDirty = computed(() =>
  mlFields.value.some(
    (field) =>
      !sameValue(mlState[field.key], field.value ?? field.defaultValue ?? null),
  ),
)

const resetMlSettings = () => {
  mlFields.value.forEach((field) => {
    mlState[field.key] = field.value ?? field.defaultValue ?? null
  })
}

const toast = useToast()
const { t } = useI18n()
const mlJobLoading = ref(false)

interface MlStatus {
  enabled: boolean
  clip: boolean
  face: boolean
  ocr: boolean
  ping: boolean
  lastRecognitionSweep: string | null
}

const { data: mlStatus, refresh: refreshMlStatus } = useFetch<MlStatus>(
  '/api/ml/status',
)

const queueMlJobs = async (mode: 'missing' | 'all') => {
  if (mode === 'all' && !window.confirm(t('dashboard.queue.messages.mlReindexConfirm'))) {
    return
  }
  mlJobLoading.value = true
  try {
    const result = await $fetch<{ enqueued: number; success: boolean }>(
      '/api/ml/jobs/queue-all',
      { method: 'POST', body: { type: 'all', mode } },
    )
    toast.add({
      title: t('dashboard.queue.messages.mlQueued'),
      description: t('dashboard.queue.messages.mlQueuedDescription', {
        count: result.enqueued,
      }),
      color: result.success ? 'success' : 'warning',
    })
  } catch (err: any) {
    toast.add({
      title: t('dashboard.queue.messages.operationFailed'),
      description: err?.data?.message || err?.message,
      color: 'error',
    })
  } finally {
    mlJobLoading.value = false
    refreshMlStatus()
  }
}

const handleMlSettingsSubmit = async () => {
  const mlData = Object.fromEntries(
    mlFields.value.map((f) => [f.key, mlState[f.key]]),
  )
  try {
    await submitMl(mlData)
  } catch {
    /* empty */
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('title.mlSettings')" />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <section
          class="space-y-2 border-b border-neutral-200 pb-4 dark:border-neutral-800"
        >
          <h2
            class="text-xl font-semibold text-neutral-900 dark:text-neutral-100"
          >
            {{ $t('title.mlSettings') }}
          </h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {{ $t('settings.ml.sectionDescription') }}
          </p>
        </section>

        <section
          class="rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
        >
          <header
            class="border-b border-neutral-200 px-5 py-4 dark:border-neutral-800"
          >
            <h3
              class="text-base font-semibold text-neutral-900 dark:text-neutral-100"
            >
              {{ $t('title.mlSettings') }}
            </h3>
          </header>

          <div
            v-if="mlLoading && mlFields.length === 0"
            class="space-y-4 px-5 py-5"
          >
            <USkeleton class="h-4 w-44" />
            <USkeleton class="h-12 w-full" />
          </div>

          <UForm
            v-else
            id="mlSettingsForm"
            class="space-y-5 px-5 py-5"
            @submit="handleMlSettingsSubmit"
          >
            <SettingField
              v-for="field in mlFields"
              :key="field.key"
              :field="field"
              :model-value="mlState[field.key]"
              @update:model-value="(val) => (mlState[field.key] = val)"
            />
          </UForm>

          <footer
            class="border-t border-neutral-200 px-5 py-4 dark:border-neutral-800"
          >
            <div
              v-if="isMlDirty"
              class="mb-3 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800 dark:border-warning-900/60 dark:bg-warning-950/30 dark:text-warning-200"
            >
              {{ $t('common.unsavedChanges') }}
            </div>

            <div class="flex items-center justify-end gap-2">
              <UButton
                color="neutral"
                variant="outline"
                :disabled="!isMlDirty"
                @click="resetMlSettings"
              >
                {{ $t('common.actions.reset') }}
              </UButton>
              <UButton
                :loading="mlLoading"
                type="submit"
                form="mlSettingsForm"
                :disabled="!isMlDirty"
                icon="tabler:device-floppy"
              >
                {{ $t('common.actions.saveSettings') }}
              </UButton>
            </div>
          </footer>
        </section>

        <section
          class="space-y-3 rounded-md border border-neutral-200 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {{ $t('settings.ml.jobs.title') }}
          </h3>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {{
              mlStatus?.ping
                ? $t('settings.ml.jobs.online')
                : $t('settings.ml.jobs.offline')
            }}
            <span v-if="mlStatus?.lastRecognitionSweep">
              · {{ $t('settings.ml.jobs.lastSweep') }}
              {{ mlStatus.lastRecognitionSweep }}
            </span>
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton
              variant="soft"
              icon="tabler:sparkles"
              :loading="mlJobLoading"
              @click="queueMlJobs('missing')"
            >
              {{ $t('dashboard.queue.actions.mlMissing') }}
            </UButton>
            <UButton
              color="warning"
              variant="soft"
              icon="tabler:refresh-alert"
              :loading="mlJobLoading"
              @click="queueMlJobs('all')"
            >
              {{ $t('dashboard.queue.actions.mlAll') }}
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
