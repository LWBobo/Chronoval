<script lang="ts" setup>
import { getPersonVersions } from '~/utils/collection-versions'
const props = defineProps<{
  photoId: string
  visible?: boolean
}>()

interface FaceDto {
  metadataVersion: number
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  personId?: string | null
  personName?: string | null
}

interface PersonOption {
  id: string
  name: string | null
  ownershipType: string
  ownerId: number | null
}

const { loggedIn, user } = useUserSession()
const isAdmin = computed(() => Boolean(loggedIn.value && user.value?.isAdmin))
const { t } = useI18n()
const toast = useToast()

const faces = ref<FaceDto[]>([])
const people = ref<PersonOption[]>([])
const menuFaceId = ref<string | null>(null)
const assignPersonId = ref<string>('')
const newName = ref('')
const saving = ref(false)

const menuFace = computed(() =>
  faces.value.find((face) => face.id === menuFaceId.value),
)

async function loadFaces(id: string) {
  faces.value = []
  menuFaceId.value = null
  if (!id) return
  try {
    const res = await $fetch<{ faces: FaceDto[] }>(`/api/photos/${id}/faces`)
    faces.value = res.faces || []
  } catch {
    faces.value = []
  }
}

async function loadPeople() {
  if (!isAdmin.value) return
  try {
    const res = await $fetch<{ people: PersonOption[] }>('/api/people', {
      query: { minFaces: 0, manage: 1 },
    })
    const photo: any = await $fetch(`/api/admin/photos/${props.photoId}`)
    people.value = (res.people || []).filter(person => person.ownershipType === photo.ownershipType && person.ownerId === photo.ownerId)
  } catch {
    people.value = []
  }
}

watch(
  () => props.photoId,
  (id) => {
    loadFaces(id)
  },
  { immediate: true },
)

function personLabel(person: PersonOption) {
  return person.name?.trim() || t('ui.people.unnamed')
}

function facePinned(face: FaceDto) {
  return menuFaceId.value === face.id
}

function openMenu(face: FaceDto) {
  menuFaceId.value = face.id
  assignPersonId.value = face.personId || ''
  newName.value = ''
  loadPeople()
}

async function saveAssign(payload: {
  personId?: string | null
  createPerson?: boolean
  name?: string | null
}) {
  if (!menuFace.value || saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/faces/${menuFace.value.id}`, {
      method: 'PUT',
      body: { ...payload, expectedMetadataVersion: menuFace.value.metadataVersion, versions: await getPersonVersions([menuFace.value.personId, payload.personId].filter((id): id is string => !!id)), reason: t('accounts.reassignReason') },
    })
    menuFaceId.value = null
    await loadFaces(props.photoId)
    toast.add({ title: t('ui.people.reassignSaved'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('ui.people.reassignFailed'),
      description: err?.data?.message || err?.message,
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="visible !== false && faces.length"
    class="pointer-events-none absolute inset-0 z-20"
  >
    <div
      v-for="face in faces"
      :key="face.id"
      class="group pointer-events-auto absolute"
      :style="{
        left: `${face.x1 * 100}%`,
        top: `${face.y1 * 100}%`,
        width: `${Math.max(0, (face.x2 - face.x1) * 100)}%`,
        height: `${Math.max(0, (face.y2 - face.y1) * 100)}%`,
      }"
    >
      <NuxtLink
        v-if="face.personId"
        :to="`/people/${face.personId}`"
        class="pointer-events-none absolute inset-0 rounded border-2 border-white/80 opacity-0 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 hover:border-emerald-400"
        :class="facePinned(face) && 'pointer-events-auto opacity-100'"
        :title="face.personName || $t('ui.people.unnamed')"
      />
      <div
        v-else
        class="pointer-events-none absolute inset-0 rounded border-2 border-white/80 opacity-0 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] transition-opacity duration-150 group-hover:opacity-100"
        :class="facePinned(face) && 'opacity-100'"
      />
      <span
        v-if="face.personName || face.personId"
        class="pointer-events-none absolute -top-5 left-0 max-w-[12rem] truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        :class="facePinned(face) && 'opacity-100'"
      >
        {{ face.personName || $t('ui.people.unnamed') }}
      </span>
      <button
        v-if="isAdmin"
        type="button"
        class="pointer-events-none absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
        :class="facePinned(face) && 'pointer-events-auto opacity-100'"
        :aria-label="$t('ui.people.reassign')"
        @click.stop="openMenu(face)"
      >
        <UIcon
          name="tabler:pencil"
          class="size-3"
        />
      </button>
    </div>

    <form
      v-if="isAdmin && menuFace"
      class="pointer-events-auto absolute bottom-2 left-2 z-30 w-56 space-y-2 rounded-md bg-black/80 p-2 text-xs text-white"
      @submit.prevent="
        saveAssign({
          personId: assignPersonId || null,
        })
      "
    >
      <p class="font-medium">
        {{ $t('ui.people.reassign') }}
      </p>
      <select
        v-model="assignPersonId"
        class="w-full rounded bg-white/10 px-2 py-1"
      >
        <option value="">
          {{ $t('ui.people.unassign') }}
        </option>
        <option
          v-for="person in people"
          :key="person.id"
          :value="person.id"
        >
          {{ personLabel(person) }}
        </option>
      </select>
      <div class="flex gap-1">
        <button
          type="submit"
          class="rounded bg-white/20 px-2 py-1"
          :disabled="saving"
        >
          {{ $t('ui.people.save') }}
        </button>
        <button
          type="button"
          class="rounded px-2 py-1"
          @click="menuFaceId = null"
        >
          {{ $t('ui.people.cancel') }}
        </button>
      </div>
      <div class="flex gap-1">
        <input
          v-model="newName"
          class="min-w-0 flex-1 rounded bg-white/10 px-2 py-1"
          :placeholder="$t('ui.people.newPerson')"
        />
        <button
          type="button"
          class="rounded bg-white/20 px-2 py-1"
          :disabled="saving"
          @click="saveAssign({ createPerson: true, name: newName })"
        >
          {{ $t('ui.people.create') }}
        </button>
      </div>
    </form>
  </div>
</template>
