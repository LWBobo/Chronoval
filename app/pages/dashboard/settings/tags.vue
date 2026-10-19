<script lang="ts" setup>
definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: () => $t('title.tagSettings'),
})

interface MlTag {
  id: number
  name: string
  prompt: string
  enabled: boolean
  aliases: string[]
  appliedCount: number
}

const toast = useToast()
const { t } = useI18n()
const tags = ref<MlTag[]>([])
const saving = ref(false)
const editingId = ref<number | null>(null)
const formSectionRef = ref<HTMLElement>()
const draft = reactive({
  name: '',
  prompt: '',
  aliases: '',
  enabled: true,
})

const splitAliases = (value: string) =>
  value
    .split(/[,，;；:：、|/\\\-–—－]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const resetDraft = () => {
  editingId.value = null
  draft.name = ''
  draft.prompt = ''
  draft.aliases = ''
  draft.enabled = true
}

const loadTags = async () => {
  const result = await $fetch<{ tags: MlTag[] }>('/api/ml/tags')
  tags.value = result.tags
}

const editTag = (tag: MlTag) => {
  editingId.value = tag.id
  draft.name = tag.name
  draft.prompt = tag.prompt
  draft.aliases = tag.aliases.join(', ')
  draft.enabled = tag.enabled
  nextTick(() => {
    formSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

const saveTag = async () => {
  saving.value = true
  try {
    const body = {
      name: draft.name,
      prompt: draft.prompt,
      aliases: splitAliases(draft.aliases),
      enabled: draft.enabled,
    }
    const result = editingId.value
      ? await $fetch<{ photos: number }>(`/api/ml/tags/${editingId.value}`, {
          method: 'PUT',
          body,
        })
      : await $fetch<{ photos: number }>('/api/ml/tags', {
          method: 'POST',
          body,
        })
    toast.add({
      title: t('settings.ml.tags.saved'),
      description: t('settings.ml.tags.assigned', { count: result.photos }),
      color: 'success',
    })
    resetDraft()
    await loadTags()
  } catch (err: any) {
    toast.add({
      title: t('dashboard.queue.messages.operationFailed'),
      description: err?.data?.statusMessage || err?.message,
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

const removeTag = async (tag: MlTag) => {
  saving.value = true
  try {
    await $fetch(`/api/ml/tags/${tag.id}`, { method: 'DELETE' })
    if (editingId.value === tag.id) resetDraft()
    toast.add({ title: t('settings.ml.tags.deleted'), color: 'success' })
    await loadTags()
  } catch (err: any) {
    toast.add({
      title: t('dashboard.queue.messages.operationFailed'),
      description: err?.data?.statusMessage || err?.message,
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

const assignTags = async () => {
  saving.value = true
  try {
    const result = await $fetch<{ photos: number }>('/api/ml/tags/assign', {
      method: 'POST',
    })
    toast.add({
      title: t('settings.ml.tags.saved'),
      description: t('settings.ml.tags.assigned', { count: result.photos }),
      color: 'success',
    })
    await loadTags()
  } catch (err: any) {
    toast.add({
      title: t('dashboard.queue.messages.operationFailed'),
      description: err?.data?.statusMessage || err?.message,
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadTags().catch((err: any) => {
    toast.add({
      title: t('dashboard.queue.messages.operationFailed'),
      description: err?.data?.statusMessage || err?.message,
      color: 'error',
    })
  })
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('title.tagSettings')" />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <section
          class="space-y-2 border-b border-neutral-200 pb-4 dark:border-neutral-800"
        >
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {{ $t('title.tagSettings') }}
          </h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {{ $t('settings.ml.tags.description') }}
          </p>
        </section>

        <section
          class="space-y-2 rounded-md border border-neutral-200 bg-white px-5 py-4 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400"
        >
          <h3 class="font-medium text-neutral-900 dark:text-neutral-100">
            {{ $t('settings.ml.tags.rulesTitle') }}
          </h3>
          <ul class="list-disc space-y-1 pl-5">
            <li>{{ $t('settings.ml.tags.ruleAuto') }}</li>
            <li>{{ $t('settings.ml.tags.ruleManual') }}</li>
            <li>{{ $t('settings.ml.tags.ruleSearch') }}</li>
            <li>{{ $t('settings.ml.tags.ruleFilter') }}</li>
          </ul>
        </section>

        <section
          ref="formSectionRef"
          class="space-y-4 rounded-md border border-neutral-200 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField :label="$t('settings.ml.tags.name')">
              <UInput
                v-model="draft.name"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="$t('settings.ml.tags.prompt')"
              :help="$t('settings.ml.tags.promptHint')"
            >
              <UInput
                v-model="draft.prompt"
                class="w-full"
              />
            </UFormField>
            <UFormField
              class="sm:col-span-2"
              :label="$t('settings.ml.tags.aliases')"
              :help="$t('settings.ml.tags.aliasesHint')"
            >
              <UInput
                v-model="draft.aliases"
                class="w-full"
              />
            </UFormField>
          </div>
          <UCheckbox
            v-model="draft.enabled"
            :label="$t('settings.ml.tags.enabled')"
          />
          <div class="flex flex-wrap gap-2">
            <UButton
              :loading="saving"
              :disabled="!draft.name.trim()"
              icon="tabler:tag"
              @click="saveTag"
            >
              {{ editingId ? $t('settings.ml.tags.save') : $t('settings.ml.tags.add') }}
            </UButton>
            <UButton
              v-if="editingId"
              color="neutral"
              variant="outline"
              @click="resetDraft"
            >
              {{ $t('settings.ml.tags.cancel') }}
            </UButton>
            <UButton
              color="neutral"
              variant="soft"
              :loading="saving"
              :disabled="tags.length === 0"
              @click="assignTags"
            >
              {{ $t('settings.ml.tags.assign') }}
            </UButton>
          </div>
        </section>

        <section
          class="space-y-4 rounded-md border border-neutral-200 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <p
            v-if="tags.length === 0"
            class="text-sm text-neutral-500"
          >
            {{ $t('settings.ml.tags.empty') }}
          </p>
          <ul
            v-else
            class="divide-y divide-neutral-200 dark:divide-neutral-800"
          >
            <li
              v-for="tag in tags"
              :key="tag.id"
              class="flex items-start justify-between gap-3 py-3"
            >
              <div class="min-w-0 space-y-1">
                <p class="font-medium text-neutral-900 dark:text-neutral-100">
                  {{ tag.name }}
                  <span class="text-xs font-normal text-neutral-500">
                    · {{ $t('settings.ml.tags.appliedCount', { count: tag.appliedCount }) }}
                  </span>
                </p>
                <p class="text-sm text-neutral-500">
                  {{ tag.prompt }}
                </p>
                <p
                  v-if="tag.aliases.length"
                  class="text-xs text-neutral-500"
                >
                  {{ $t('settings.ml.tags.aliases') }}：{{ tag.aliases.join('、') }}
                </p>
                <p
                  v-if="!tag.enabled"
                  class="text-xs text-neutral-500"
                >
                  {{ $t('settings.ml.tags.disabled') }}
                </p>
              </div>
              <div class="flex shrink-0 gap-2">
                <UButton
                  size="xs"
                  variant="ghost"
                  @click="editTag(tag)"
                >
                  {{ $t('settings.ml.tags.edit') }}
                </UButton>
                <UButton
                  size="xs"
                  color="error"
                  variant="ghost"
                  :disabled="saving"
                  @click="removeTag(tag)"
                >
                  {{ $t('settings.ml.tags.delete') }}
                </UButton>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
