<script setup lang="ts">
import { createClientId } from '~/utils/client-id'
const props = defineProps<{ photos: Array<{ id: string; aclVersion: number }>; admin?: boolean }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()
const visibility = ref('private'), recipientIds = ref<number[]>([]), reason = ref(''), confirmed = ref(false)
const busy = ref(false), error = ref(''), request = ref<any>(null)
watch([visibility, recipientIds, reason, confirmed, () => props.photos.map(row => row.id).join(',')], () => { request.value = null }, { deep: true })
async function save() {
  if (busy.value || !props.photos.length || !confirmed.value) return
  busy.value = true; error.value = ''
  try {
    request.value ||= { operationId: createClientId(), items: props.photos.map(row => ({ id: row.id, expectedAclVersion: row.aclVersion })), visibility: visibility.value, recipientIds: visibility.value === 'shared' ? [...recipientIds.value] : [], reason: reason.value || undefined }
    await $fetch(props.admin ? '/api/admin/photos/visibility-batch' : '/api/me/photos/visibility-batch', { method: 'POST', body: request.value })
    emit('saved')
  } catch (e: any) { error.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
    <p>{{ $t('accounts.batchSelected', { count: photos.length }) }}</p>
    <USelect v-model="visibility" :items="['private','public','shared'].map(value => ({ value, label: $t(`accounts.visibility_${value}`) }))" />
    <UserPicker v-if="visibility === 'shared'" v-model="recipientIds" />
    <p class="text-sm text-amber-700">{{ $t('accounts.batchReplaceWarning') }}</p>
    <UInput v-if="admin" v-model="reason" :placeholder="$t('permissions.reason')" class="w-full" />
    <UCheckbox v-model="confirmed" :label="$t('accounts.batchConfirm', { count: photos.length })" />
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <div class="flex gap-2"><UButton :loading="busy" :disabled="!confirmed || photos.length > 100 || (visibility === 'shared' && !recipientIds.length) || (admin && !reason.trim())" @click="save">{{ $t('accounts.saveVisibility') }}</UButton><UButton variant="ghost" :disabled="busy" @click="emit('cancel')">{{ $t('accounts.cancel') }}</UButton></div>
  </section>
</template>
