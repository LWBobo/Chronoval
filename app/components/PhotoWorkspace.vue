<script setup lang="ts">
import { createClientId } from '~/utils/client-id'
const props = withDefaults(defineProps<{ mode?: 'mine' | 'trash' | 'shared-with-me' | 'shared-by-me'; admin?: boolean }>(), { mode: 'mine', admin: false })
const { user } = useUserSession()
const { t } = useI18n()
const items = ref<any[]>([]), nextCursor = ref<string | null>(null), error = ref(''), loading = ref(false), busy = ref(false)
const query = ref(''), ownerFilter = ref<number[]>([]), adminMode = ref<'mine'|'trash'>('mine'), uploadOwner = ref<number[]>([]), uploadSite = ref(true)
const stateFilter = ref('all'), visibilityFilter = ref('all'), sourceFilter = ref('all'), moderationFilter = ref('all'), fromDate = ref(''), untilDate = ref('')
const uploaderFilter = ref<number[]>([]), recipientFilter = ref<number[]>([])
const initialOwner = Number(useRoute().query.ownerId)
if (props.admin && Number.isSafeInteger(initialOwner) && initialOwner > 0) ownerFilter.value = [initialOwner]
const profile = ref<{ canUpload: boolean; quotaBytes: number | null; maxFileBytes: number; trashRetentionDays: number | null; usage: { usedBytes: number; reservedBytes: number }; managedUploadsSupported: boolean } | null>(null)
const detail = ref<any>(null), preview = ref<any>(null), actionPhoto = ref<any>(null), action = ref(''), actionReason = ref(''), actionError = ref('')
const form = reactive({ title: '', description: '', tags: '', visibility: 'private', recipientIds: [] as number[], reason: '' })
const transferTarget = ref<number[]>([]), transferReason = ref(''), transferKey = ref(''), transferTask = ref<any>(null), transferPhoto = ref<any>(null)
const selectedIds = ref<string[]>([])
const maxSelectedPhotos = 100
const selectablePhotos = computed(() => items.value.filter(row => row.capabilities?.canManage))
const selectedPhotos = computed(() => selectablePhotos.value.filter(row => selectedIds.value.includes(row.id)))
const batchPhotos = computed(() => selectedPhotos.value.every(row => row.capabilities?.canChangeVisibility) ? selectedPhotos.value : [])
const filterOptions = (prefix: string, values: string[]) => [{ value: 'all', label: t('accounts.filterAll') }, ...values.map(value => ({ value, label: t(`accounts.${prefix}${value}`) }))]
function dateQuery(value: string, nextDay = false) {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  if (nextDay) date.setDate(date.getDate() + 1)
  return date.toISOString()
}
function selectPhoto(id: string, checked: boolean) {
  if (checked && !selectablePhotos.value.some(row => row.id === id)) return
  selectedIds.value = checked ? [...new Set([...selectedIds.value, id])].slice(0, maxSelectedPhotos) : selectedIds.value.filter(value => value !== id)
}
function selectAllPhotos() { selectedIds.value = selectablePhotos.value.slice(0, maxSelectedPhotos).map(row => row.id) }
async function batchSaved() { selectedIds.value = []; await load() }
const endpoint = computed(() => props.admin ? '/api/admin/photos' : '/api/me/photos')
const mode = computed(() => props.admin ? adminMode.value : props.mode)
const titleKey = computed(() => props.admin ? 'allPhotos' : ({ mine: 'mine', trash: 'trash', 'shared-with-me': 'sharedWithMe', 'shared-by-me': 'sharedByMe' }[props.mode]))
let sequence = 0, timer: ReturnType<typeof setInterval> | undefined
let disposed = false
const bytes = (value: number) => `${(value / 1024 ** 3).toFixed(2)} GiB`
async function load(more = false, quiet = false) {
  const run = ++sequence
  if (!quiet) loading.value = true
  error.value = ''
  try {
    const response: any = await $fetch(endpoint.value, { query: { mode: mode.value, limit: 50, q: query.value || undefined, ownerId: props.admin ? ownerFilter.value[0] : undefined, state: stateFilter.value === 'all' ? undefined : stateFilter.value, visibility: visibilityFilter.value === 'all' ? undefined : visibilityFilter.value, source: props.admin && sourceFilter.value !== 'all' ? sourceFilter.value : undefined, moderationStatus: props.admin && moderationFilter.value !== 'all' ? moderationFilter.value : undefined, uploadedBy: props.admin ? uploaderFilter.value[0] : undefined, recipientId: recipientFilter.value[0], from: dateQuery(fromDate.value), until: dateQuery(untilDate.value, true), cursor: more ? nextCursor.value || undefined : undefined } })
    if (disposed || run !== sequence) return
    items.value = more ? [...items.value, ...response.items] : response.items
    const selectableIds = new Set(selectablePhotos.value.map(row => row.id))
    selectedIds.value = selectedIds.value.filter(id => selectableIds.has(id))
    nextCursor.value = response.nextCursor
    if (!more) {
      if (detail.value && !items.value.some(row => row.id === detail.value.id && row.capabilities?.canManage)) detail.value = null
      if (preview.value && !items.value.some(row => row.id === preview.value.id)) preview.value = null
    }
    const account = await $fetch('/api/me/profile') as any
    if (!disposed && run === sequence) profile.value = account
  } catch (e: any) { if (run === sequence) error.value = e?.data?.message || e.message }
  finally { if (run === sequence) loading.value = false }
}
async function edit(photo: any) {
  const run = sequence
  error.value = ''
  try {
    const row: any = await $fetch(`${endpoint.value}/${photo.id}`)
    if (disposed || run !== sequence) return
    detail.value = row
    Object.assign(form, { title: row.title || '', description: row.description || '', tags: (row.tags || []).join(', '), visibility: row.visibility, recipientIds: row.recipientIds || [], reason: '' })
  } catch (e: any) { error.value = e?.data?.message || e.message }
}
async function saveMetadata() {
  if (!detail.value) return
  const photoId = detail.value.id, run = sequence
  busy.value = true; actionError.value = ''
  try {
    const saved: any = await $fetch(`${endpoint.value}/${detail.value.id}`, { method: 'PATCH', body: { expectedVersion: detail.value.metadataVersion, title: form.title, description: form.description, tags: form.tags.split(',').map(tag => tag.trim()).filter(Boolean), reason: form.reason || undefined } })
    if (!disposed && run === sequence && detail.value?.id === photoId) detail.value = { ...detail.value, ...saved }
    await load()
  } catch (e: any) { if (e?.statusCode === 404 || e?.status === 404) detail.value = null; actionError.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
async function saveVisibility() {
  if (!detail.value) return
  const photoId = detail.value.id, run = sequence
  busy.value = true; actionError.value = ''
  try {
    const saved: any = await $fetch(`${endpoint.value}/${detail.value.id}/visibility`, { method: 'PUT', body: { expectedAclVersion: detail.value.aclVersion, visibility: form.visibility, recipientIds: form.visibility === 'shared' ? form.recipientIds : [], reason: form.reason || undefined } })
    if (!disposed && run === sequence && detail.value?.id === photoId) detail.value = { ...detail.value, ...saved }
    await load()
  } catch (e: any) { if (e?.statusCode === 404 || e?.status === 404) detail.value = null; actionError.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
function prepareAction(photo: any, value: string) { actionPhoto.value = photo; action.value = value; actionReason.value = ''; actionError.value = '' }
function prepareBatchAction(value: string) { prepareAction({ batch: true, title: t('accounts.batchSelected', { count: selectedPhotos.value.length }), operationId: createClientId(), items: selectedPhotos.value.map(row => ({ id: row.id, expectedVersion: row.metadataVersion })) }, value) }
async function performAction() {
  if (!actionPhoto.value) return
  busy.value = true; actionError.value = ''
  try {
    if (actionPhoto.value.batch) await $fetch(`${endpoint.value}/lifecycle-batch`, { method: 'POST', body: { operationId: actionPhoto.value.operationId, action: action.value, items: actionPhoto.value.items, reason: actionReason.value || undefined } })
    else if (action.value === 'block' || action.value === 'unblock') await $fetch(`/api/admin/photos/${actionPhoto.value.id}/moderation`, { method: 'POST', body: { blocked: action.value === 'block', reason: actionReason.value } })
    else await $fetch(`${endpoint.value}/${actionPhoto.value.id}/${action.value}`, { method: 'POST', body: { reason: actionReason.value || undefined } })
    actionPhoto.value = null; selectedIds.value = []; await load()
  } catch (e: any) { actionError.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
async function beginTransfer(photo: any) {
  transferPhoto.value = photo; transferTarget.value = []; transferReason.value = ''; transferTask.value = null; transferKey.value = createClientId(); actionError.value = ''
  if (photo.activeTransferId) { try { transferTask.value = await $fetch(`/api/admin/photo-transfers/${photo.activeTransferId}`) } catch (e: any) { actionError.value = e?.data?.message || e.message } }
}
async function transfer() {
  if (!transferPhoto.value || !transferTarget.value[0]) return
  busy.value = true; actionError.value = ''
  try {
    transferTask.value = await $fetch(`/api/admin/photos/${transferPhoto.value.id}/transfer`, { method: 'POST', body: { toUserId: transferTarget.value[0], expectedAclVersion: transferPhoto.value.aclVersion, idempotencyKey: transferKey.value, reason: transferReason.value } })
    await load()
  } catch (e: any) { actionError.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
async function retryTransfer() {
  if (!transferTask.value || !transferReason.value.trim()) return
  busy.value = true; actionError.value = ''
  try { transferTask.value = await $fetch(`/api/admin/photo-transfers/${transferTask.value.id}/retry`, { method: 'POST', body: { reason: transferReason.value } }); await load() }
  catch (e: any) { actionError.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
watch(() => [props.mode, props.admin, adminMode.value, ownerFilter.value[0]], () => { selectedIds.value = []; items.value = []; detail.value = null; preview.value = null; void load() })
watch(() => `${user.value?.id}:${user.value?.authVersion}`, () => { sequence++; selectedIds.value = []; items.value = []; detail.value = null; preview.value = null; transferPhoto.value = null; actionPhoto.value = null; profile.value = null; void load() })
onMounted(async () => {
  await load()
  timer = setInterval(async () => {
    if (document.hidden || busy.value) return
    try {
      if (transferTask.value && !['completed', 'failed'].includes(transferTask.value.state)) transferTask.value = await $fetch(`/api/admin/photo-transfers/${transferTask.value.id}`)
      if (items.value.some(row => ['uploading','processing','purging'].includes(row.processingStatus) || row.transferState !== 'idle')) await load(false, true)
    } catch (e: any) { error.value = e?.data?.message || e.message }
  }, 5000)
})
onBeforeUnmount(() => { disposed = true; sequence++; clearInterval(timer); items.value = []; detail.value = null; preview.value = null })
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3"><h1 class="text-2xl font-semibold">{{ $t(`accounts.${titleKey}`) }}</h1><UButton variant="outline" :loading="loading" @click="load()">{{ $t('accounts.refresh') }}</UButton></div>
    <p v-if="profile && !admin" class="text-sm text-neutral-500">{{ $t('accounts.used') }} {{ bytes(profile.usage?.usedBytes || 0) }} + {{ $t('accounts.reserved') }} {{ bytes(profile.usage?.reservedBytes || 0) }} / {{ profile.quotaBytes === null ? $t('accounts.unlimited') : bytes(profile.quotaBytes) }}</p>
    <section v-if="admin" class="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div class="flex flex-wrap gap-2"><USelect v-model="adminMode" :items="[{ value:'mine',label:$t('accounts.allPhotos') },{ value:'trash',label:$t('accounts.trash') }]" /><UButton variant="ghost" @click="ownerFilter = []">{{ $t('accounts.allOwners') }}</UButton></div>
      <UFormField :label="$t('accounts.owner')"><UserPicker v-model="ownerFilter" single include-inactive /></UFormField>
      <UFormField :label="$t('accounts.uploader')"><UserPicker v-model="uploaderFilter" single include-inactive /></UFormField>
      <p class="text-xs text-neutral-500">{{ $t('accounts.singleUserHint') }}</p>
      <UCheckbox v-model="uploadSite" :label="$t('accounts.uploadToSite')" />
      <UserPicker v-if="!uploadSite" v-model="uploadOwner" single />
      <ControlledUploadPanel :key="`${uploadSite}:${uploadOwner[0]}`" admin :owner-user-id="uploadSite ? null : uploadOwner[0]" :max-file-bytes="profile?.maxFileBytes" :disabled="!uploadSite && uploadOwner.length !== 1" @uploaded="load()" />
    </section>
    <ControlledUploadPanel v-else-if="mode === 'mine' && profile?.canUpload && profile.managedUploadsSupported" :max-file-bytes="profile.maxFileBytes" :remaining-bytes="profile.quotaBytes === null ? null : Math.max(0, profile.quotaBytes - profile.usage.usedBytes - profile.usage.reservedBytes)" @uploaded="load()" />
    <UAlert v-else-if="mode === 'mine'" color="warning" :title="$t(profile?.managedUploadsSupported ? 'accounts.uploadDisabled' : 'accounts.storageUnsupported')" />
    <p v-if="mode === 'trash' && profile?.trashRetentionDays" class="text-sm text-neutral-500">{{ $t('accounts.trashRetention', { days: profile.trashRetentionDays }) }}</p>
    <p v-if="mode === 'trash' && admin" class="text-sm text-amber-700">{{ $t('accounts.scanTrashWarning') }}</p>
    <form class="flex flex-wrap items-end gap-2" @submit.prevent="selectedIds = []; load()">
      <UInput v-model="query" class="min-w-0 flex-1" :placeholder="$t('accounts.searchPhotos')" />
      <UFormField :label="$t('accounts.status')"><USelect v-model="stateFilter" :items="filterOptions('processing_', ['uploading','processing','ready','failed','purging'])" /></UFormField>
      <UFormField :label="$t('permissions.visibility')"><USelect v-model="visibilityFilter" :items="filterOptions('visibility_', ['private','public','shared'])" /></UFormField>
      <UFormField v-if="admin" :label="$t('accounts.source')"><USelect v-model="sourceFilter" :items="filterOptions('source_', ['upload','library'])" /></UFormField>
      <UFormField v-if="admin" :label="$t('accounts.moderation')"><USelect v-model="moderationFilter" :items="filterOptions('moderation_', ['visible','blocked'])" /></UFormField>
      <UFormField :label="$t('accounts.fromDate')"><UInput v-model="fromDate" type="date" /></UFormField><UFormField :label="$t('accounts.untilDate')"><UInput v-model="untilDate" type="date" /></UFormField>
      <UButton type="submit">{{ $t('accounts.search') }}</UButton>
    </form>
    <UFormField v-if="mode === 'shared-by-me'" :label="$t('accounts.recipient')"><UserPicker v-model="recipientFilter" single /></UFormField>
    <div v-if="selectablePhotos.length" class="flex flex-wrap items-center gap-2">
      <UButton type="button" variant="outline" :disabled="loading || busy" @click="selectAllPhotos">{{ $t('accounts.selectLoadedPhotos') }}</UButton>
      <UButton type="button" variant="ghost" :disabled="!selectedPhotos.length || busy" @click="selectedIds = []">{{ $t('accounts.clearPhotoSelection') }}</UButton>
      <p class="text-xs text-neutral-500" role="status">{{ $t('accounts.photoSelectionHint', { selected: selectedPhotos.length, loaded: selectablePhotos.length, max: maxSelectedPhotos }) }}</p>
    </div>
    <div v-if="selectedPhotos.length" class="flex flex-wrap gap-2"><UButton v-if="mode !== 'trash'" variant="outline" @click="prepareBatchAction('trash')">{{ $t('accounts.batchTrash') }} ({{ selectedPhotos.length }})</UButton><template v-else><UButton variant="outline" @click="prepareBatchAction('restore')">{{ $t('accounts.restore') }} ({{ selectedPhotos.length }})</UButton><UButton v-if="selectedPhotos.every(row => row.capabilities.canPurge)" color="error" variant="outline" @click="prepareBatchAction('purge')">{{ $t('accounts.purge') }} ({{ selectedPhotos.length }})</UButton></template></div>
    <PhotoVisibilityBatchPanel v-if="mode !== 'trash' && batchPhotos.length" :photos="batchPhotos" :admin="admin" @saved="batchSaved" @cancel="selectedIds = []" />
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <p v-if="!loading && !items.length" class="text-neutral-500">{{ $t('accounts.empty') }}</p>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <article v-for="photo in items" :key="photo.id" class="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <button class="block aspect-[4/3] w-full bg-neutral-100 dark:bg-neutral-900" type="button" :disabled="!photo.originalUrl" @click="preview = photo"><img v-if="photo.thumbnailUrl" :src="photo.thumbnailUrl" :alt="photo.title || ''" class="h-full w-full object-cover" loading="lazy" /><span v-else>{{ $t(`accounts.processing_${photo.processingStatus || 'ready'}`) }}</span></button>
        <div class="space-y-2 p-3"><UCheckbox v-if="photo.capabilities?.canManage" :model-value="selectedIds.includes(photo.id)" :disabled="!selectedIds.includes(photo.id) && selectedIds.length >= maxSelectedPhotos" :label="$t('accounts.selectPhoto')" @update:model-value="value => selectPhoto(photo.id, !!value)" /><p class="truncate font-medium">{{ photo.title || photo.originalFilename || photo.id }}</p><p v-if="admin" class="text-xs text-neutral-500">{{ $t('accounts.owner') }}: {{ photo.owner ? `${photo.owner.displayName} (${photo.owner.username})` : $t('accounts.siteOwnership') }} · {{ $t('accounts.uploader') }}: {{ photo.uploader?.username || '—' }}</p><p v-if="photo.shareCount !== undefined" class="text-xs text-neutral-500">{{ $t('accounts.shareCount', { count: photo.shareCount }) }}</p>
          <p class="text-xs text-neutral-500">{{ photo.visibility === 'inherit' ? $t('accounts.siteOwnership') : $t(`accounts.visibility_${photo.visibility || 'shared'}`) }} · {{ $t(`accounts.processing_${photo.processingStatus || 'ready'}`) }}</p>
          <p v-if="photo.transferState && photo.transferState !== 'idle'" class="text-xs text-amber-700">{{ $t(`accounts.transfer_${photo.transferState}`) }}</p><p v-if="photo.moderationStatus === 'blocked'" class="text-xs text-red-600">{{ $t('accounts.blocked') }}: {{ photo.moderationReason }}</p>
          <div class="flex flex-wrap gap-2"><UButton v-if="admin && photo.activeTransferId" size="xs" variant="ghost" @click="beginTransfer(photo)">{{ $t('accounts.transferProgress') }}</UButton><UButton v-if="photo.capabilities?.canManage" size="xs" variant="outline" @click="actionError = ''; edit(photo)">{{ $t('accounts.edit') }}</UButton><UButton v-if="photo.capabilities?.canManage && mode !== 'trash'" size="xs" color="neutral" variant="ghost" @click="prepareAction(photo,'trash')">{{ $t('accounts.trash') }}</UButton><UButton v-if="photo.capabilities?.canManage && mode === 'trash'" size="xs" variant="outline" @click="prepareAction(photo,'restore')">{{ $t('accounts.restore') }}</UButton><UButton v-if="photo.capabilities?.canPurge" size="xs" color="error" variant="ghost" @click="prepareAction(photo,'purge')">{{ $t('accounts.purge') }}</UButton><UButton v-if="photo.processingStatus === 'failed' && photo.capabilities?.canManage" size="xs" variant="ghost" @click="prepareAction(photo,'retry')">{{ $t('accounts.retry') }}</UButton><UButton v-if="photo.capabilities?.canTransfer" size="xs" variant="ghost" @click="beginTransfer(photo)">{{ $t('accounts.transfer') }}</UButton><UButton v-if="admin && photo.capabilities?.canManage" size="xs" variant="ghost" @click="prepareAction(photo, photo.moderationStatus === 'blocked' ? 'unblock' : 'block')">{{ $t(photo.moderationStatus === 'blocked' ? 'accounts.unblock' : 'accounts.block') }}</UButton></div>
        </div>
      </article>
    </div>
    <UButton v-if="nextCursor" :loading="loading" @click="load(true)">{{ $t('accounts.loadMore') }}</UButton>
    <UModal :open="!!preview" :title="preview?.title || $t('accounts.preview')" @update:open="value => { if (!value) preview = null }"><template #body><video v-if="preview?.type === 'video'" :src="preview.originalUrl" controls playsinline class="max-h-[70vh] w-full" /><img v-else-if="preview?.originalUrl" :src="preview.originalUrl" class="max-h-[70vh] w-full object-contain" :alt="preview.title || ''" /><video v-if="preview?.livePhotoVideoUrl" :src="preview.livePhotoVideoUrl" controls playsinline class="mt-3 max-h-[50vh] w-full" /><UButton v-if="preview?.downloadUrl" :href="`${preview.downloadUrl}?download=1`" target="_blank" class="mt-3">{{ $t('accounts.downloadOriginal') }}</UButton></template></UModal>
    <UModal :open="!!detail" :title="$t('accounts.edit')" @update:open="value => { if (!value) detail = null }"><template #body><div v-if="detail" class="space-y-4"><UInput v-model="form.title" class="w-full" :placeholder="$t('accounts.photoTitle')" /><UTextarea v-model="form.description" class="w-full" :placeholder="$t('accounts.description')" /><UInput v-model="form.tags" class="w-full" :placeholder="$t('accounts.tags')" /><UInput v-model="form.reason" class="w-full" :placeholder="$t('permissions.reason')" /><UButton :loading="busy" @click="saveMetadata">{{ $t('accounts.saveMetadata') }}</UButton><template v-if="detail.capabilities.canChangeVisibility"><USelect v-model="form.visibility" :items="['private','public','shared'].map(value => ({value,label:$t(`accounts.visibility_${value}`)}))" class="w-full" /><UserPicker v-if="form.visibility === 'shared'" v-model="form.recipientIds" :exclude-id="detail.ownerId" /><p class="text-xs text-neutral-500">{{ $t('permissions.intersectionHint') }}</p><UButton :loading="busy" @click="saveVisibility">{{ $t('accounts.saveVisibility') }}</UButton></template><p v-if="actionError" class="text-red-600" role="alert">{{ actionError }}</p></div></template></UModal>
    <UModal :open="!!actionPhoto" :title="$t(`accounts.${action}`)" @update:open="value => { if (!value) actionPhoto = null }"><template #body><p>{{ actionPhoto?.title || actionPhoto?.id }}</p><p class="my-3 text-sm">{{ $t(action === 'purge' ? 'accounts.purgeWarning' : 'accounts.actionConfirm') }}</p><UInput v-if="admin" v-model="actionReason" class="w-full" :placeholder="$t('permissions.reason')" /><p v-if="actionError" class="mt-3 text-red-600" role="alert">{{ actionError }}</p></template><template #footer><UButton :loading="busy" :color="action === 'purge' ? 'error' : 'primary'" @click="performAction">{{ $t('accounts.confirm') }}</UButton></template></UModal>
    <UModal :open="!!transferPhoto" :title="$t('accounts.transfer')" @update:open="value => { if (!value) transferPhoto = null }">
      <template #body>
        <div class="space-y-3">
          <p>{{ transferPhoto?.originalFilename || transferPhoto?.title }}</p>
          <p v-if="transferPhoto?.owner" class="text-sm">{{ $t('accounts.owner') }}: {{ transferPhoto.owner.displayName }} ({{ transferPhoto.owner.username }}) · {{ bytes(transferPhoto.originalBytes || 0) }}</p>
          <p>{{ $t('accounts.transferWarning') }}</p>
          <template v-if="!transferTask"><UserPicker v-model="transferTarget" single :exclude-id="transferPhoto?.ownerId" /><UInput v-model="transferReason" class="w-full" :placeholder="$t('permissions.reason')" /></template>
          <div v-else class="space-y-2">
            <p>{{ $t(`accounts.transfer_${transferTask.state}`) }}</p>
            <p>{{ transferTask.filesVerified }}/{{ transferTask.filesTotal }} · {{ $t('accounts.cleaned') }} {{ transferTask.sourcesDeleted }}</p>
            <p>{{ $t('accounts.transferProgress') }}: {{ bytes(transferTask.bytesVerified || 0) }} / {{ bytes(transferTask.bytesTotal || 0) }}</p>
            <p v-if="transferTask.errorCode" class="text-red-600">{{ transferTask.errorCode }}</p>
            <template v-if="transferTask.state === 'cleanup_pending' && transferTask.errorCode"><UInput v-model="transferReason" class="mt-3 w-full" :placeholder="$t('permissions.reason')" /><UButton class="mt-3" :loading="busy" :disabled="!transferReason.trim()" @click="retryTransfer">{{ $t('accounts.retry') }}</UButton></template>
          </div>
          <p v-if="actionError" class="text-red-600" role="alert">{{ actionError }}</p>
        </div>
      </template>
      <template #footer><UButton v-if="!transferTask" :disabled="transferTarget.length !== 1 || !transferReason.trim()" :loading="busy" @click="transfer">{{ $t('accounts.confirmTransfer') }}</UButton></template>
    </UModal>
  </div>
</template>
