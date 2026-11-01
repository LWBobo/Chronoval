<script setup lang="ts">
import { createClientId } from '~/utils/client-id'
definePageMeta({ layout: 'dashboard' })
const { t } = useI18n()
const items = ref<any[]>([]), cursor = ref<string | null>(null), query = ref(''), status = ref('all'), busy = ref(false), error = ref('')
const detail = ref<any>(null), creating = ref(false), credentials = ref<{ username: string; password: string } | null>(null)
const form = reactive({ username: '', displayName: '', email: '', password: '', canUpload: true, quotaGiB: '20', unlimited: false, role: 'user', reason: '' })
const pendingAction = ref(''), actionReason = ref(''), deleteMode = ref<'transfer'|'purge'>('transfer'), targets = ref<number[]>([]), deleteKey = ref('')
const available = ref<string | null>(null)
let searchSequence = 0, usernameTimer: ReturnType<typeof setTimeout> | undefined, refreshTimer: ReturnType<typeof setInterval> | undefined
let disposed = false
const bytes = (value: number) => `${(value / 1024 ** 3).toFixed(2)} GiB`
function quota() {
  const n = Number(form.quotaGiB)
  if (!form.unlimited && (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 1024 ** 3)))) throw new Error(t('accounts.quotaInvalid'))
  return form.unlimited ? null : Math.round(n * 1024 ** 3)
}
async function load(more = false) {
  const run = ++searchSequence
  try {
    const response: any = await $fetch('/api/admin/users', { query: { q: query.value, status: status.value === 'all' ? undefined : status.value, cursor: more ? cursor.value || undefined : undefined } })
    if (disposed || run !== searchSequence) return
    items.value = more ? [...items.value, ...response.items] : response.items; cursor.value = response.nextCursor
  } catch (e: any) { error.value = e?.data?.message || e.message }
}
function create() {
  Object.assign(form, { username: '', displayName: '', email: '', password: '', canUpload: true, quotaGiB: '20', unlimited: false, role: 'user', reason: '' })
  detail.value = null; available.value = null; creating.value = true; error.value = ''
}
async function edit(row: any) {
  try {
    detail.value = await $fetch(`/api/admin/users/${row.id}`)
    Object.assign(form, { ...detail.value, quotaGiB: String((detail.value.quotaBytes || 0) / 1024 ** 3), unlimited: detail.value.quotaBytes === null, password: '', reason: '' })
  } catch (e: any) { error.value = e?.data?.message || e.message }
}
async function perform(action: () => Promise<void>) {
  busy.value = true; error.value = ''
  try { await action(); await load() } catch (e: any) { error.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
async function save() {
  await perform(async () => {
    if (creating.value) {
      const result: any = await $fetch('/api/admin/users', { method: 'POST', body: { username: form.username, displayName: form.displayName || undefined, email: form.email, password: form.password || undefined, canUpload: form.canUpload, quotaBytes: quota() } })
      credentials.value = { username: result.user.username, password: result.initialPassword }; creating.value = false; form.password = ''
    } else if (detail.value) {
      const userId: number = detail.value.id
      await $fetch(`/api/admin/users/${userId}`, { method: 'PATCH', body: { expectedVersion: detail.value.version, displayName: form.displayName, email: form.email, canUpload: form.canUpload, quotaBytes: quota(), role: form.role, reason: form.reason } })
      await edit(detail.value)
    }
  })
}
function prepare(action: string) { pendingAction.value = action; actionReason.value = ''; targets.value = []; deleteMode.value = 'transfer'; deleteKey.value = createClientId() }
async function executeAction() {
  if (!detail.value) return
  await perform(async () => {
    if (pendingAction.value === 'delete') {
      await $fetch(`/api/admin/users/${detail.value.id}/delete`, { method: 'POST', body: { expectedVersion: detail.value.version, mode: deleteMode.value, targetUserId: deleteMode.value === 'transfer' ? targets.value[0] : undefined, reason: actionReason.value, idempotencyKey: deleteKey.value } })
    } else {
      const result: any = await $fetch(`/api/admin/users/${detail.value.id}/${pendingAction.value}`, { method: 'POST', body: { expectedVersion: detail.value.version, reason: actionReason.value } })
      if (result.initialPassword) credentials.value = { username: detail.value.username, password: result.initialPassword }
    }
    pendingAction.value = ''; await edit(detail.value)
  })
}
async function retryDeletion() {
  await perform(async () => { await $fetch(`/api/admin/user-deletions/${detail.value.deletionTask.id}/retry`, { method: 'POST', body: { reason: form.reason } }); await edit(detail.value) })
}
async function reconcileStorage() {
  if (!detail.value) return
  await perform(async () => {
    const userId: number = detail.value.id
    await $fetch(`/api/admin/users/${userId}/reconcile-storage`, { method: 'POST', body: { expectedVersion: detail.value.version, reason: form.reason } })
    await edit(detail.value)
  })
}
watch(status, () => load())
watch(() => form.username, () => {
  clearTimeout(usernameTimer); available.value = null
  const name = form.username
  usernameTimer = setTimeout(async () => {
    if (!creating.value || !name) return
    try { const response: any = await $fetch('/api/admin/users/username-availability', { query: { username: name } }); if (name === form.username && !disposed) available.value = response.valid ? t(response.available ? 'accounts.usernameAvailable' : 'accounts.usernameTaken') : response.message || t('accounts.usernameRules') }
    catch (e: any) { if (name === form.username) available.value = e?.data?.message || e.message }
  }, 300)
})
onMounted(async () => {
  await load()
  refreshTimer = setInterval(async () => {
    if (document.hidden || busy.value || !detail.value?.deletionTask || ['completed','failed'].includes(detail.value.deletionTask.state)) return
    try { detail.value.deletionTask = await $fetch(`/api/admin/user-deletions/${detail.value.deletionTask.id}`); await load() } catch (e: any) { error.value = e?.data?.message || e.message }
  }, 5000)
})
onBeforeUnmount(() => { disposed = true; searchSequence++; clearTimeout(usernameTimer); clearInterval(refreshTimer); credentials.value = null; form.password = '' })
</script>

<template>
  <UDashboardPanel><template #body><div class="space-y-5">
    <div class="flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ $t('accounts.users') }}</h1><UButton @click="create">{{ $t('accounts.createUser') }}</UButton></div>
    <form class="flex flex-wrap gap-2" @submit.prevent="load()"><UInput v-model="query" :placeholder="$t('accounts.searchUsers')" /><USelect v-model="status" :items="['all','active','disabled','deleting','deleted'].map(value => ({value,label:$t(`accounts.status_${value}`)}))" /><UButton type="submit">{{ $t('accounts.search') }}</UButton></form>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead><tr><th>{{ $t('accounts.username') }}</th><th>{{ $t('accounts.displayName') }}</th><th>{{ $t('accounts.status') }}</th><th>{{ $t('accounts.used') }} / {{ $t('accounts.quota') }}</th><th /></tr></thead><tbody><tr v-for="row in items" :key="row.id" class="border-b border-neutral-200 dark:border-neutral-800"><td class="py-3">{{ row.username }}<p class="text-xs text-neutral-500">{{ row.email }}</p></td><td>{{ row.displayName }}</td><td>{{ $t(`accounts.status_${row.status}`) }} · {{ $t(`accounts.role_${row.role}`) }}</td><td>{{ bytes(row.usage.usedBytes) }} + {{ bytes(row.usage.reservedBytes) }} / {{ row.quotaBytes === null ? $t('accounts.unlimited') : bytes(row.quotaBytes) }}</td><td><UButton variant="ghost" @click="edit(row)">{{ $t('accounts.edit') }}</UButton></td></tr></tbody></table></div>
    <UButton v-if="cursor" @click="load(true)">{{ $t('accounts.loadMore') }}</UButton>
    <UModal :open="creating || !!detail" :title="$t(creating ? 'accounts.createUser' : 'accounts.userDetails')" @update:open="value => { if (!value) { creating = false; detail = null; form.password = '' } }"><template #body><form class="space-y-4" @submit.prevent="save">
      <UFormField :label="$t('accounts.username')"><UInput v-model="form.username" :disabled="!creating" class="w-full" required /><p v-if="creating" class="mt-1 text-xs">{{ $t('accounts.usernameRules') }} {{ available }}</p></UFormField>
      <p class="break-all text-xs text-neutral-500">{{ $t('accounts.uploadDirectory') }}: photos/{{ form.username.trim().toLowerCase() }}/</p>
      <UFormField :label="$t('accounts.displayName')"><UInput v-model="form.displayName" class="w-full" :required="!creating" /></UFormField><UFormField label="Email"><UInput v-model="form.email" type="email" class="w-full" required /></UFormField>
      <UFormField v-if="creating" :label="$t('accounts.initialPassword')"><UInput v-model="form.password" type="password" autocomplete="new-password" class="w-full" :placeholder="$t('accounts.passwordGenerated')" :minlength="12" :maxlength="128" /></UFormField>
      <UCheckbox v-model="form.canUpload" :label="$t('accounts.allowUpload')" /><UCheckbox v-model="form.unlimited" :label="$t('accounts.unlimited')" /><UFormField :label="`${$t('accounts.quota')} (GiB)`"><UInput v-model="form.quotaGiB" type="number" min="0" step="0.1" :disabled="form.unlimited" /></UFormField>
      <p v-if="detail && !form.unlimited && Number(form.quotaGiB) * 1024 ** 3 < detail.usage.usedBytes + detail.usage.reservedBytes" class="text-sm text-amber-700">{{ $t('accounts.quotaLowerWarning') }}</p>
      <USelect v-if="!creating" v-model="form.role" :items="['admin','user'].map(value => ({value,label:$t(`accounts.role_${value}`)}))" />
      <UInput v-if="!creating" v-model="form.reason" :placeholder="$t('permissions.reason')" class="w-full" required />
      <p v-if="error" class="text-red-600" role="alert">{{ error }}</p><UButton v-if="creating || !['deleting','deleted'].includes(detail?.status)" type="submit" :loading="busy">{{ $t('accounts.save') }}</UButton>
      <div v-if="detail && !['deleting','deleted'].includes(detail.status)" class="flex flex-wrap gap-2"><UButton v-for="action in [detail.status === 'active' ? 'disable' : 'restore','revoke-sessions','reset-password','reset-2fa','delete']" :key="action" type="button" variant="outline" :color="action === 'delete' ? 'error' : 'neutral'" @click="prepare(action)">{{ $t(`accounts.action_${action}`) }}</UButton></div>
      <div v-if="detail?.deletionTask" class="space-y-2"><p>{{ $t('accounts.deletionProgress') }}: {{ detail.deletionTask.state }} · {{ $t('accounts.remainingPhotos') }} {{ detail.deletionTask.remainingPhotos }} · {{ bytes(detail.deletionTask.remainingBytes) }}</p><p v-if="detail.deletionTask.errorCode" class="text-red-600">{{ detail.deletionTask.errorCode }}</p><UButton v-if="detail.deletionTask.state === 'failed'" type="button" :loading="busy" :disabled="!form.reason.trim()" @click="retryDeletion">{{ $t('accounts.retry') }}</UButton></div>
      <section v-if="detail" class="space-y-3 border-t pt-4">
        <h2 class="font-semibold">{{ $t('accounts.photoStats') }}</h2>
        <p>{{ $t('accounts.totalPhotos') }}: {{ detail.stats.total }} · {{ bytes(detail.stats.bytes) }}</p>
        <div class="flex flex-wrap gap-3 text-sm"><span v-for="key in ['public','private','shared','processing','failed','trash','blocked']" :key="key">{{ $t(`accounts.stats_${key}`) }}: {{ detail.stats[key] }}</span></div>
        <UButton :to="`/dashboard/managed-photos?ownerId=${detail.id}`" variant="outline">{{ $t('accounts.viewUserPhotos') }}</UButton>
        <p :class="detail.storageCheck.consistent ? 'text-green-700' : 'text-amber-700'">{{ $t(detail.storageCheck.consistent ? 'accounts.storageConsistent' : 'accounts.storageInconsistent') }}</p>
        <p v-if="!detail.storageCheck.consistent" class="text-sm">{{ $t('accounts.inventoryUsage') }}: {{ bytes(detail.storageCheck.computed.usedBytes) }} + {{ bytes(detail.storageCheck.computed.reservedBytes) }}</p>
        <UButton v-if="!detail.storageCheck.consistent && detail.status !== 'deleted'" type="button" variant="outline" :loading="busy" :disabled="!form.reason.trim()" @click="reconcileStorage">{{ $t('accounts.reconcileStorage') }}</UButton>
        <p v-for="task in detail.transfers" :key="task.id" class="text-sm">{{ $t('accounts.transferProgress') }}: {{ $t(`accounts.transfer_${task.state}`) }} · {{ task.fromUserId }} → {{ task.toUserId }} · {{ $t('accounts.reserved') }} {{ bytes(task.reservedBytes) }}</p>
        <h2 class="font-semibold">{{ $t('accounts.recentActions') }}</h2><p v-for="entry in detail.recentActions" :key="entry.id" class="text-sm">{{ new Date(entry.createdAt).toLocaleString() }} · {{ entry.action }} · {{ entry.reason || '—' }}</p>
      </section>
    </form></template></UModal>
    <UModal :open="!!pendingAction" :title="$t(`accounts.action_${pendingAction}`)" @update:open="value => { if (!value) pendingAction = '' }"><template #body><div class="space-y-3"><p>{{ $t(pendingAction === 'delete' ? 'accounts.deleteUserWarning' : 'accounts.actionConfirm') }}</p><template v-if="pendingAction === 'delete'"><USelect v-model="deleteMode" :items="[{value:'transfer',label:$t('accounts.transfer')},{value:'purge',label:$t('accounts.purge')}]" /><UserPicker v-if="deleteMode === 'transfer'" v-model="targets" single :exclude-id="detail?.id" /></template><UInput v-model="actionReason" :placeholder="$t('permissions.reason')" class="w-full" /><p v-if="error" class="text-red-600">{{ error }}</p></div></template><template #footer><UButton :loading="busy" :disabled="!actionReason.trim() || (pendingAction === 'delete' && deleteMode === 'transfer' && targets.length !== 1)" @click="executeAction">{{ $t('accounts.confirm') }}</UButton></template></UModal>
    <UModal :open="!!credentials" :title="$t('accounts.initialPassword')" @update:open="value => { if (!value) credentials = null }"><template #body><p class="mb-3">{{ $t('accounts.credentialsOnce') }}</p><p>{{ credentials?.username }}</p><p class="select-all break-all font-mono">{{ credentials?.password }}</p></template></UModal>
  </div></template></UDashboardPanel>
</template>
