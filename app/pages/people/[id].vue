<script lang="ts" setup>
const route = useRoute()
const personId = computed(() => String(route.params.id || ''))

interface PersonDetail {
  id: string
  name: string | null
  faceCount: number
  isHidden?: boolean
  thumbnailUrl: string | null
}

interface PersonOption {
  id: string
  name: string | null
}

interface PersonPhoto {
  id: string
  title: string | null
  thumbnailUrl: string | null
  thumbnailHash: string | null
  aspectRatio: number | null
  dateTaken: string | null
  type: string
}

const { loggedIn } = useUserSession()
const { t } = useI18n()
const toast = useToast()
const nameDraft = ref('')
const saving = ref(false)
const mergeSourceId = ref('')

const { data: peoplePayload, refresh: refreshPeople } = useAsyncData(
  'people-merge-options',
  () =>
    loggedIn.value
      ? $fetch<{ people: PersonOption[] }>('/api/people', {
          query: { minFaces: 0 },
        })
      : Promise.resolve({ people: [] as PersonOption[] }),
  { watch: [loggedIn] },
)

const mergeOptions = computed(() =>
  (peoplePayload.value?.people || []).filter(
    (person) => person.id !== personId.value,
  ),
)

const { data, pending, error, refresh } = useAsyncData(
  () => `person-${personId.value}`,
  () =>
    $fetch<{ person: PersonDetail; photos: PersonPhoto[] }>(
      `/api/people/${personId.value}`,
    ),
  { watch: [personId] },
)

const person = computed(() => data.value?.person)
const photos = computed(() => data.value?.photos || [])

const displayName = computed(
  () => person.value?.name?.trim() || (person.value ? t('ui.people.unnamed') : ''),
)

watch(person, (value) => {
  nameDraft.value = value?.name || ''
})

async function savePerson(patch: {
  name?: string | null
  isHidden?: boolean
}) {
  if (!person.value || saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/people/${person.value.id}`, {
      method: 'PUT',
      body: patch,
    })
    await refresh()
    toast.add({ title: t('ui.people.saved'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('ui.people.saveFailed'),
      description: err?.data?.message || err?.message,
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

async function mergeIntoThis() {
  if (!person.value || !mergeSourceId.value || saving.value) return
  saving.value = true
  try {
    await $fetch('/api/people/merge', {
      method: 'POST',
      body: {
        targetId: person.value.id,
        sourceIds: [mergeSourceId.value],
      },
    })
    mergeSourceId.value = ''
    await Promise.all([refresh(), refreshPeople()])
    toast.add({ title: t('ui.people.merged'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('ui.people.mergeFailed'),
      description: err?.data?.message || err?.message,
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

useHead({
  title: () => displayName.value || $t('title.people'),
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
      <div
        v-if="pending"
        class="flex items-center gap-4"
      >
        <USkeleton class="size-24 rounded-full" />
        <div class="space-y-2">
          <USkeleton class="h-6 w-40" />
          <USkeleton class="h-4 w-24" />
        </div>
      </div>

      <p
        v-else-if="error"
        class="text-sm text-error-600"
      >
        {{ error.message }}
      </p>

      <template v-else-if="person">
        <header class="mb-8 flex items-center gap-4">
          <div
            class="size-24 shrink-0 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          >
            <img
              v-if="person.thumbnailUrl"
              :src="person.thumbnailUrl"
              :alt="displayName"
              class="size-full object-cover"
            />
            <div
              v-else
              class="flex size-full items-center justify-center text-neutral-400"
            >
              <UIcon
                name="tabler:user"
                class="size-12"
              />
            </div>
          </div>
          <div>
            <h1
              class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100"
            >
              {{ displayName }}
            </h1>
            <p class="mt-1 text-sm text-neutral-500">
              {{ $t('ui.people.faces', { count: person.faceCount }) }}
              ·
              {{ $t('ui.people.photos', { count: photos.length }) }}
            </p>
            <form
              v-if="loggedIn"
              class="mt-3 flex flex-col gap-2"
              @submit.prevent="savePerson({ name: nameDraft.trim() || null })"
            >
              <div class="flex flex-wrap items-center gap-2">
                <UInput
                  v-model="nameDraft"
                  size="sm"
                  :placeholder="$t('ui.people.namePlaceholder')"
                />
                <UButton
                  type="submit"
                  size="sm"
                  :loading="saving"
                >
                  {{ $t('ui.people.save') }}
                </UButton>
                <UButton
                  type="button"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :loading="saving"
                  @click="savePerson({ isHidden: !person.isHidden })"
                >
                  {{
                    person.isHidden
                      ? $t('ui.people.show')
                      : $t('ui.people.hide')
                  }}
                </UButton>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <select
                  v-model="mergeSourceId"
                  class="rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <option value="">
                    {{ $t('ui.people.mergePick') }}
                  </option>
                  <option
                    v-for="other in mergeOptions"
                    :key="other.id"
                    :value="other.id"
                  >
                    {{ other.name?.trim() || $t('ui.people.unnamed') }}
                  </option>
                </select>
                <UButton
                  type="button"
                  size="sm"
                  color="neutral"
                  variant="soft"
                  :disabled="!mergeSourceId"
                  :loading="saving"
                  @click="mergeIntoThis"
                >
                  {{ $t('ui.people.merge') }}
                </UButton>
              </div>
            </form>
            <UButton
              to="/people"
              variant="link"
              size="xs"
              icon="tabler:arrow-left"
              class="mt-1 px-0"
            >
              {{ $t('title.people') }}
            </UButton>
          </div>
        </header>

        <div
          v-if="photos.length === 0"
          class="text-center text-sm text-neutral-500"
        >
          {{ $t('ui.people.noPhotos') }}
        </div>

        <div
          v-else
          class="columns-2 gap-2 sm:columns-3 md:columns-4 lg:columns-5"
        >
          <NuxtLink
            v-for="photo in photos"
            :key="photo.id"
            :to="`/${photo.id}`"
            class="mb-2 block break-inside-avoid overflow-hidden rounded-md"
          >
            <ThumbImage
              :src="photo.thumbnailUrl || ''"
              :thumbhash="photo.thumbnailHash"
              :alt="photo.title || photo.id"
              class="w-full"
              :style="{ aspectRatio: String(photo.aspectRatio || 1) }"
            />
          </NuxtLink>
        </div>
      </template>
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
