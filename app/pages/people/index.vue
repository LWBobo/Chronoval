<script lang="ts" setup>
useHead({
  title: () => $t('title.people'),
})

interface PersonCard {
  id: string
  name: string | null
  faceCount: number
  isHidden: boolean
  visibility?: 'public' | 'login' | 'admin'
  thumbnailUrl: string | null
  thumbnailFaceId: string | null
}

const { loggedIn, user } = useUserSession()
const isAdmin = computed(() => Boolean(loggedIn.value && user.value?.isAdmin))
const viewerKey = computed(() =>
  loggedIn.value ? (isAdmin.value ? 'admin' : 'user') : 'guest',
)

const { data, pending, error, refresh } = useAsyncData(
  () => `people-list-${viewerKey.value}`,
  () =>
    $fetch<{ people: PersonCard[] }>('/api/people', {
      query: { minFaces: 1 },
    }),
  { watch: [viewerKey] },
)

const people = computed(() =>
  (data.value?.people || []).filter((person) => {
    const visibility = person.visibility || (person.isHidden ? 'admin' : 'public')
    if (visibility === 'public') return true
    if (!loggedIn.value) return false
    if (visibility === 'admin') return isAdmin.value
    return true
  }),
)

const { t } = useI18n()

const displayName = (p: PersonCard) =>
  p.name?.trim() || t('ui.people.unnamed')
</script>

<template>
  <div class="relative min-h-svh">
    <div
      class="page-backdrop pointer-events-none fixed inset-0 -z-10"
      aria-hidden="true"
    />
    <AppTopHeader />

    <div class="mx-auto w-full max-w-6xl px-4 pt-16 pb-20">
      <header class="mb-8">
        <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          {{ $t('title.people') }}
        </h1>
        <p class="mt-1 text-sm text-neutral-500">
          {{ $t('ui.people.count', { count: people.length }) }}
        </p>
      </header>

      <div
        v-if="pending"
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      >
        <USkeleton
          v-for="i in 10"
          :key="i"
          class="aspect-square rounded-xl"
        />
      </div>

      <p
        v-else-if="error"
        class="text-sm text-error-600"
      >
        {{ error.message }}
        <UButton
          size="xs"
          variant="link"
          @click="refresh()"
        >
          {{ $t('ui.people.retry') }}
        </UButton>
      </p>

      <p
        v-else-if="people.length === 0"
        class="text-center text-sm text-neutral-500"
      >
        {{ $t('ui.people.empty') }}
      </p>

      <div
        v-else
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      >
        <NuxtLink
          v-for="person in people"
          :key="person.id"
          :to="`/people/${person.id}`"
          class="group flex flex-col items-center gap-2"
        >
          <div
            class="aspect-square w-full overflow-hidden rounded-full bg-neutral-200 ring-2 ring-transparent transition group-hover:ring-primary-400 dark:bg-neutral-800"
          >
            <img
              v-if="person.thumbnailUrl"
              :src="person.thumbnailUrl"
              :alt="displayName(person)"
              class="size-full object-cover"
              loading="lazy"
            />
            <div
              v-else
              class="flex size-full items-center justify-center text-neutral-400"
            >
              <UIcon
                name="tabler:user"
                class="size-10"
              />
            </div>
          </div>
          <div class="text-center">
            <p
              class="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100"
            >
              {{ displayName(person) }}
            </p>
            <p class="text-xs text-neutral-500">
              {{ $t('ui.people.faces', { count: person.faceCount }) }}
            </p>
            <p
              v-if="isAdmin && person.visibility && person.visibility !== 'public'"
              class="text-[11px] text-amber-600 dark:text-amber-400"
            >
              {{ $t(`ui.people.visibility.${person.visibility}`) }}
            </p>
          </div>
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
