<script lang="ts" setup>
import { getCollectionVersions, getPersonVersions } from '~/utils/collection-versions'
definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: () => $t('title.peopleAlbums'),
})

type PersonVisibility = 'public' | 'login' | 'selected' | 'admin'

interface PersonAlbum {
  id: string
  collectionId: number
  ownershipType: 'site' | 'user'
  name: string | null
  faceCount: number
  photoCount?: number
  visibility: PersonVisibility
  thumbnailUrl: string | null
}

interface PhotoHit {
  id: string
  title: string | null
  thumbnailUrl: string | null
  dateTaken: string | null
  already: boolean
}

const { t } = useI18n()
const toast = useToast()

const people = ref<PersonAlbum[]>([])
const loading = ref(true)
const searchQuery = ref('')
const filter = ref<'all' | PersonVisibility>('all')
const savingId = ref<string | null>(null)
const nameDrafts = reactive<Record<string, string>>({})
const selectedIds = ref<string[]>([])
const deleteOpen = ref(false)
const pendingDeleteIds = ref<string[]>([])
const deleting = ref(false)
const addTarget = ref<PersonAlbum | null>(null)
const addOpen = ref(false)
const photoQuery = ref('')
const photoHits = ref<PhotoHit[]>([])
const photoLoading = ref(false)
const photoLoadingMore = ref(false)
const photoNextCursor = ref<string | null>(null)
const failedThumbnailIds = ref(new Set<string>())
const pickedIds = ref<string[]>([])
const adding = ref(false)
const creating = ref(false)
const newPersonName = ref('')
let photoTimer: ReturnType<typeof setTimeout> | undefined
let photoSearchRun = 0

const levels: PersonVisibility[] = ['public', 'login', 'selected', 'admin']
const accessTarget = ref<PersonAlbum | null>(null)
const accessDraft = ref<import('~~/shared/types/permissions').CollectionAccessInput | null>(null)
const accessError = ref('')
async function saveAccess() {
  if (!accessTarget.value || !accessDraft.value) return
  savingId.value = accessTarget.value.id
  try {
    await $fetch(`/api/admin/collections/${accessTarget.value.collectionId}/access`, { method: 'PUT', body: accessDraft.value })
    accessTarget.value = null
    await loadPeople()
  } catch (e: any) { accessError.value = e?.data?.message || e.message }
  finally { savingId.value = null }
}

const displayName = (person: PersonAlbum) =>
  person.name?.trim() || t('dashboard.people.unnamed')

const filteredPeople = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return people.value.filter((person) => {
    if (filter.value !== 'all' && person.visibility !== filter.value)
      return false
    if (!q) return true
    return displayName(person).toLowerCase().includes(q)
  })
})

const allFilteredSelected = computed(
  () =>
    filteredPeople.value.length > 0 &&
    filteredPeople.value.every((person) =>
      selectedIds.value.includes(person.id),
    ),
)

const pendingDeleteNames = computed(() =>
  pendingDeleteIds.value
    .map((id) => people.value.find((person) => person.id === id))
    .filter((person): person is PersonAlbum => Boolean(person))
    .map((person) => displayName(person)),
)

const loadPeople = async () => {
  loading.value = true
  try {
    const response = await $fetch<{ people: PersonAlbum[] }>('/api/people', {
      query: { manage: '1' },
    })
    people.value = (response.people || []).map((person) => ({
      ...person,
      visibility: person.visibility || 'public',
    }))
    for (const person of people.value) {
      nameDrafts[person.id] = person.name || ''
    }
    const alive = new Set(people.value.map((person) => person.id))
    selectedIds.value = selectedIds.value.filter((id) => alive.has(id))
  } catch (error) {
    console.error('Failed to load people albums:', error)
    toast.add({
      title: t('dashboard.people.loadError'),
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}

const renamePerson = async (person: PersonAlbum) => {
  if (savingId.value) return
  const name = nameDrafts[person.id]?.trim() || null
  if ((person.name || null) === name) return
  savingId.value = person.id
  try {
    const saved = await $fetch<{ person: PersonAlbum }>(
      `/api/people/${person.id}`,
      {
        method: 'PUT',
        body: { name },
      },
    )
    person.name = saved.person.name
    nameDrafts[person.id] = saved.person.name || ''
    toast.add({ title: t('dashboard.people.renamed'), color: 'success' })
  } catch (error: any) {
    toast.add({
      title: t('dashboard.people.saveFailed'),
      description: error?.data?.message || error?.message,
      color: 'error',
    })
  } finally {
    savingId.value = null
  }
}

const toggleSelected = (id: string) => {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  } else {
    selectedIds.value = [...selectedIds.value, id]
  }
}

const toggleFiltered = () => {
  const visible = filteredPeople.value.map((person) => person.id)
  if (allFilteredSelected.value) {
    const drop = new Set(visible)
    selectedIds.value = selectedIds.value.filter((id) => !drop.has(id))
    return
  }
  selectedIds.value = [...new Set([...selectedIds.value, ...visible])]
}

const askDelete = (ids: string[]) => {
  if (!ids.length || deleting.value) return
  pendingDeleteIds.value = ids
  deleteOpen.value = true
}

const confirmDelete = async () => {
  if (!pendingDeleteIds.value.length || deleting.value) return
  deleting.value = true
  try {
    await $fetch('/api/people/bulk-delete', {
      method: 'POST',
      body: { ids: pendingDeleteIds.value, versions: await getPersonVersions(pendingDeleteIds.value), reason: t('accounts.removePersonReason') },
    })
    const drop = new Set(pendingDeleteIds.value)
    people.value = people.value.filter((person) => !drop.has(person.id))
    selectedIds.value = selectedIds.value.filter((id) => !drop.has(id))
    deleteOpen.value = false
    pendingDeleteIds.value = []
    toast.add({ title: t('dashboard.people.deleted'), color: 'success' })
  } catch (error: any) {
    toast.add({
      title: t('dashboard.people.deleteFailed'),
      description: error?.data?.message || error?.message,
      color: 'error',
    })
  } finally {
    deleting.value = false
  }
}

const photoTotal = (person: PersonAlbum) =>
  person.photoCount ?? person.faceCount

const searchPhotos = async (append = false) => {
  if (!addOpen.value || !addTarget.value) return
  if (
    append &&
    (!photoNextCursor.value || photoLoading.value || photoLoadingMore.value)
  )
    return

  const run = ++photoSearchRun
  const personId = addTarget.value.id
  const q = photoQuery.value
  const cursor = append ? photoNextCursor.value : ''
  if (append) {
    photoLoadingMore.value = true
  } else {
    photoLoading.value = true
    photoLoadingMore.value = false
    photoNextCursor.value = null
  }
  try {
    const result = await $fetch<{
      photos: PhotoHit[]
      nextCursor: string | null
    }>('/api/people/photo-search', {
      method: 'POST',
      body: { personId, q, cursor, limit: 48 },
    })
    if (run !== photoSearchRun) return
    if (append) {
      const existing = new Set(photoHits.value.map((photo) => photo.id))
      photoHits.value = [
        ...photoHits.value,
        ...(result.photos || []).filter((photo) => !existing.has(photo.id)),
      ]
    } else {
      photoHits.value = result.photos || []
    }
    photoNextCursor.value = result.nextCursor
  } catch (error: any) {
    if (run !== photoSearchRun) return
    toast.add({
      title: t('dashboard.people.addFailed'),
      description: error?.data?.message || error?.message,
      color: 'error',
    })
  } finally {
    if (run === photoSearchRun) {
      photoLoading.value = false
      photoLoadingMore.value = false
    }
  }
}

const loadMorePhotos = () => {
  void searchPhotos(true)
}

const onPhotoScroll = (event: Event) => {
  const element = event.currentTarget as HTMLElement
  const remaining =
    element.scrollHeight - element.scrollTop - element.clientHeight
  if (remaining < 160) loadMorePhotos()
}

const markThumbnailFailed = (id: string) => {
  failedThumbnailIds.value = new Set([...failedThumbnailIds.value, id])
}

const openAdd = (person: PersonAlbum) => {
  addTarget.value = person
  photoQuery.value = ''
  pickedIds.value = []
  photoHits.value = []
  photoNextCursor.value = null
  failedThumbnailIds.value = new Set()
  addOpen.value = true
  void searchPhotos()
}

const cancelPhotoSearch = () => {
  clearTimeout(photoTimer)
  photoSearchRun++
  photoNextCursor.value = null
  photoLoading.value = false
  photoLoadingMore.value = false
}

watch(
  photoQuery,
  () => {
    if (!addOpen.value) return
    cancelPhotoSearch()
    photoHits.value = []
    photoLoading.value = true
    photoTimer = setTimeout(() => {
      void searchPhotos()
    }, 250)
  },
  { flush: 'sync' },
)

watch(
  addOpen,
  (open) => {
    if (!open) cancelPhotoSearch()
  },
  { flush: 'sync' },
)

onBeforeUnmount(cancelPhotoSearch)

const togglePick = (photo: PhotoHit) => {
  if (photo.already) return
  if (pickedIds.value.includes(photo.id)) {
    pickedIds.value = pickedIds.value.filter((id) => id !== photo.id)
  } else {
    pickedIds.value = [...pickedIds.value, photo.id]
  }
}

const confirmAdd = async () => {
  if (!addTarget.value || !pickedIds.value.length || adding.value) return
  adding.value = true
  try {
    const result = await $fetch<{ added: number; photoCount: number }>(
      `/api/people/${addTarget.value.id}/photos`,
      { method: 'POST', body: { photoIds: pickedIds.value, expectedAclVersion: (await getCollectionVersions([addTarget.value.collectionId]))[String(addTarget.value.collectionId)], reason: t('accounts.membershipReason') } },
    )
    addTarget.value.photoCount = result.photoCount
    toast.add({
      title: t('dashboard.people.added', { count: result.added }),
      color: 'success',
    })
    addOpen.value = false
  } catch (error: any) {
    toast.add({
      title: t('dashboard.people.addFailed'),
      description: error?.data?.message || error?.message,
      color: 'error',
    })
  } finally {
    adding.value = false
  }
}

const createPersonAlbum = async () => {
  const name = newPersonName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    await $fetch('/api/people', { method: 'POST', body: { name } })
    newPersonName.value = ''
    await loadPeople()
  } catch (error) {
    console.error('Failed to create person album:', error)
    toast.add({ title: t('dashboard.people.createFailed'), color: 'error' })
  } finally {
    creating.value = false
  }
}

onMounted(loadPeople)
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('title.peopleAlbums')" />
</template>

    <template #body>
      <CollectionBatchPanel :collections="people.filter((item:any)=>item.ownershipType==='site'&&item.collectionId).map((item:any)=>({collectionId:item.collectionId,title:item.name||item.id}))" @saved="loadPeople()" />
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div>
          <h2 class="text-lg font-semibold text-(--ui-text)">
            {{ $t('dashboard.people.title') }}
          </h2>
          <p class="mt-1 text-sm text-(--ui-text-muted)">
            {{ $t('dashboard.people.subtitle') }}
          </p>
          <form
            class="mt-4 flex flex-col gap-2 sm:flex-row"
            @submit.prevent="createPersonAlbum"
          >
            <UInput
              v-model="newPersonName"
              class="sm:max-w-xs"
              :placeholder="$t('dashboard.people.createName')"
            />
            <UButton
              type="submit"
              icon="tabler:user-plus"
              :loading="creating"
              :disabled="!newPersonName.trim()"
            >
              {{ $t('dashboard.people.createButton') }}
            </UButton>
          </form>
        </div>

        <div class="grid gap-3 md:grid-cols-3">
          <div
            v-for="level in levels"
            :key="level"
            class="rounded-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950"
          >
            <p
              class="text-sm font-medium text-neutral-900 dark:text-neutral-100"
            >
              {{ $t(`dashboard.people.levels.${level}`) }}
            </p>
            <p class="mt-1 text-xs leading-5 text-neutral-500">
              {{ $t(`dashboard.people.hints.${level}`) }}
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              size="sm"
              :color="filter === 'all' ? 'primary' : 'neutral'"
              :variant="filter === 'all' ? 'solid' : 'soft'"
              @click="filter = 'all'"
            >
              {{ $t('dashboard.people.filterAll') }}
            </UButton>
            <UButton
              v-for="level in levels"
              :key="level"
              size="sm"
              :color="filter === level ? 'primary' : 'neutral'"
              :variant="filter === level ? 'solid' : 'soft'"
              @click="filter = level"
            >
              {{ $t(`dashboard.people.levels.${level}`) }}
            </UButton>
          </div>
          <UInput
            v-model="searchQuery"
            icon="tabler:search"
            class="w-full sm:w-56"
            :placeholder="$t('dashboard.people.searchPlaceholder')"
          />
        </div>

        <div
          class="flex flex-wrap items-center gap-2 text-xs text-(--ui-text-muted)"
        >
          <span>
            {{ $t('dashboard.people.count', { count: filteredPeople.length }) }}
          </span>
          <UButton
            v-if="filteredPeople.length"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="toggleFiltered"
          >
            {{
              allFilteredSelected
                ? $t('dashboard.people.clearSelection')
                : $t('dashboard.people.selectAll')
            }}
          </UButton>
          <UButton
            v-if="selectedIds.length"
            size="xs"
            color="error"
            variant="soft"
            icon="tabler:trash"
            @click="askDelete(selectedIds)"
          >
            {{
              $t('dashboard.people.deleteSelected', {
                count: selectedIds.length,
              })
            }}
          </UButton>
        </div>

        <div
          v-if="loading"
          class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          <USkeleton
            v-for="i in 6"
            :key="i"
            class="h-44 rounded-xl"
          />
        </div>

        <div
          v-else-if="filteredPeople.length === 0"
          class="flex flex-col items-center justify-center py-16 text-center"
        >
          <Icon
            name="tabler:users"
            size="48"
            class="mb-3 text-neutral-400"
          />
          <p class="text-sm text-neutral-500">
            {{
              people.length === 0
                ? $t('dashboard.people.empty')
                : $t('dashboard.people.searchEmpty')
            }}
          </p>
        </div>

        <div
          v-else
          class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          <article
            v-for="person in filteredPeople"
            :key="person.id"
            class="flex flex-col rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
          >
            <div class="flex items-center gap-3">
              <input
                type="checkbox"
                class="size-4 shrink-0 accent-primary-500"
                :checked="selectedIds.includes(person.id)"
                @change="toggleSelected(person.id)"
              />
              <div
                class="size-14 shrink-0 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
              >
                <img
                  v-if="person.thumbnailUrl"
                  :src="person.thumbnailUrl"
                  :alt="displayName(person)"
                  class="size-full object-cover"
                />
                <div
                  v-else
                  class="flex size-full items-center justify-center text-neutral-400"
                >
                  <Icon
                    name="tabler:user"
                    class="size-7"
                  />
                </div>
              </div>
              <div class="min-w-0 flex-1">
                <form
                  class="flex items-center gap-1.5"
                  @submit.prevent="renamePerson(person)"
                >
                  <UInput
                    v-model="nameDrafts[person.id]"
                    size="sm"
                    class="min-w-0 flex-1"
                    :placeholder="$t('dashboard.people.namePlaceholder')"
                  />
                  <UButton
                    type="submit"
                    size="sm"
                    color="neutral"
                    variant="soft"
                    icon="tabler:check"
                    :loading="savingId === person.id"
                    :aria-label="$t('dashboard.people.saveName')"
                  />
                </form>
                <p class="mt-1 text-xs text-neutral-500">
                  {{
                    $t('dashboard.people.photos', { count: photoTotal(person) })
                  }}
                </p>
              </div>
            </div>

            <div class="mt-4">
              <UButton block variant="outline" @click="accessError = ''; accessTarget = person">{{ $t('permissions.edit') }} · {{ $t(`permissions.${person.visibility}`) }}</UButton>
            </div>

            <div class="mt-2 flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <UButton
                  :to="`/people/${person.id}`"
                  target="_blank"
                  variant="link"
                  size="xs"
                  icon="tabler:external-link"
                  class="px-0"
                >
                  {{ $t('dashboard.people.open') }}
                </UButton>
                <UButton
                  size="xs"
                  color="primary"
                  variant="soft"
                  icon="tabler:photo-plus"
                  @click="openAdd(person)"
                >
                  {{ $t('dashboard.people.addPhotos') }}
                </UButton>
              </div>
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="tabler:trash"
                @click="askDelete([person.id])"
              >
                {{ $t('dashboard.people.delete') }}
              </UButton>
            </div>
          </article>
        </div>

        <UModal v-model:open="addOpen">
          <template #content>
            <div class="flex max-h-[80vh] flex-col gap-4 p-6">
              <div>
                <h3 class="text-lg font-semibold">
                  {{
                    $t('dashboard.people.addTitle', {
                      name: addTarget ? displayName(addTarget) : '',
                    })
                  }}
                </h3>
                <p class="mt-1 text-sm text-neutral-500">
                  {{ $t('dashboard.people.addHint') }}
                </p>
              </div>
              <UInput
                v-model="photoQuery"
                icon="tabler:search"
                :placeholder="$t('dashboard.people.addSearch')"
              />
              <div
                class="min-h-40 flex-1 overflow-y-auto"
                @scroll.passive="onPhotoScroll"
              >
                <div
                  v-if="photoLoading"
                  class="grid grid-cols-3 gap-2 sm:grid-cols-4"
                >
                  <USkeleton
                    v-for="i in 8"
                    :key="i"
                    class="aspect-square rounded-md"
                  />
                </div>
                <p
                  v-else-if="photoHits.length === 0"
                  class="py-8 text-center text-sm text-neutral-500"
                >
                  {{ $t('dashboard.people.addEmpty') }}
                </p>
                <div
                  v-else
                  class="grid grid-cols-3 gap-2 sm:grid-cols-4"
                >
                  <button
                    v-for="photo in photoHits"
                    :key="photo.id"
                    type="button"
                    class="relative aspect-square overflow-hidden rounded-md bg-neutral-200 text-left dark:bg-neutral-800"
                    :class="
                      photo.already
                        ? 'cursor-default opacity-60'
                        : 'cursor-pointer'
                    "
                    @click="togglePick(photo)"
                  >
                    <img
                      v-if="
                        photo.thumbnailUrl && !failedThumbnailIds.has(photo.id)
                      "
                      :src="photo.thumbnailUrl"
                      :alt="photo.title || photo.id"
                      class="size-full object-cover"
                      loading="lazy"
                      @error="markThumbnailFailed(photo.id)"
                    />
                    <span
                      v-else
                      class="flex size-full flex-col items-center justify-center gap-1 px-2 text-center text-neutral-500"
                    >
                      <Icon
                        name="tabler:photo-off"
                        class="size-6"
                      />
                      <span class="line-clamp-2 text-[10px]">
                        {{ photo.title || photo.id }}
                      </span>
                    </span>
                    <span
                      v-if="photo.already"
                      class="absolute inset-x-1 bottom-1 rounded bg-black/70 px-1 py-0.5 text-center text-[10px] text-white"
                    >
                      {{ $t('dashboard.people.addAlready') }}
                    </span>
                    <span
                      v-else-if="pickedIds.includes(photo.id)"
                      class="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-primary-500 text-white"
                    >
                      <Icon
                        name="tabler:check"
                        class="size-3.5"
                      />
                    </span>
                  </button>
                </div>
                <div
                  v-if="photoNextCursor"
                  class="flex justify-center py-3"
                >
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="soft"
                    icon="tabler:chevron-down"
                    :loading="photoLoadingMore"
                    @click="loadMorePhotos"
                  >
                    {{ $t('dashboard.people.addLoadMore') }}
                  </UButton>
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  @click="addOpen = false"
                >
                  {{ $t('dashboard.people.cancel') }}
                </UButton>
                <UButton
                  icon="tabler:photo-plus"
                  :disabled="pickedIds.length === 0"
                  :loading="adding"
                  @click="confirmAdd"
                >
                  {{
                    $t('dashboard.people.addConfirm', {
                      count: pickedIds.length,
                    })
                  }}
                </UButton>
              </div>
            </div>
          </template>
        </UModal>

        <UModal v-model:open="deleteOpen">
          <template #content>
            <div class="space-y-4 p-6">
              <h3 class="text-lg font-semibold">
                {{
                  pendingDeleteIds.length > 1
                    ? $t('dashboard.people.deleteSelectedTitle')
                    : $t('dashboard.people.deleteTitle')
                }}
              </h3>
              <p class="text-sm text-neutral-600 dark:text-neutral-400">
                {{
                  pendingDeleteIds.length > 1
                    ? $t('dashboard.people.deleteSelectedMessage', {
                        count: pendingDeleteIds.length,
                      })
                    : $t('dashboard.people.deleteMessage', {
                        name: pendingDeleteNames[0] || '',
                      })
                }}
              </p>
              <div class="flex justify-end gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  @click="deleteOpen = false"
                >
                  {{ $t('dashboard.people.cancel') }}
                </UButton>
                <UButton
                  color="error"
                  icon="tabler:trash"
                  :loading="deleting"
                  @click="confirmDelete"
                >
                  {{ $t('dashboard.people.deleteConfirm') }}
                </UButton>
              </div>
            </div>
          </template>
        </UModal>
      </div>
    </template>
  </UDashboardPanel>
      <UModal :open="!!accessTarget" @update:open="value => { if (!value) accessTarget = null }" :title="$t('permissions.edit')">
    <template #body>
      <CollectionAccessEditor v-if="accessTarget" :key="accessTarget.collectionId" v-model="accessDraft" :collection-id="accessTarget.collectionId" />
      <p v-if="accessError" class="mt-3 text-red-600" role="alert">{{ accessError }}</p>
    </template>
    <template #footer><UButton :loading="!!savingId" :disabled="!accessDraft || accessTarget?.ownershipType === 'user'" @click="saveAccess">{{ $t('permissions.save') }}</UButton></template>
  </UModal>
</template>
