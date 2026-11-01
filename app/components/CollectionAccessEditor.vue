<script setup lang="ts">
import type { CollectionAccessInput } from '~~/shared/types/permissions'
const props = defineProps<{ collectionId?: number | null }>()
const model = defineModel<CollectionAccessInput | null>({ required: true })
const { t } = useI18n()
const loading = ref(false)
const error = ref('')
const inherited = ref<Array<{ collectionId: number; path: string; visibility: string; passwordProtected: boolean }>>([])
const editable = ref(true)
const previewUsers = ref<number[]>([])
const previewContext = ref<'front' | 'manage'>('front')
const preview = ref<any>(null)
const previewLoading = ref(false)
const previewError = ref('')
let request = 0
let previewRequest = 0
const levels = computed(() => ['public', 'login', 'selected', 'admin'].map(value => ({ value, label: t(`permissions.${value}`) })))
const passwordActions = computed(() => ['keep', 'set', 'clear'].map(value => ({ value, label: t(`permissions.password_${value}`) })))
const exemptionModes = computed(() => ['none', 'logged_in', 'selected'].map(value => ({ value, label: t(`permissions.exempt_${value}`) })))
async function load() {
  const run = ++request
  model.value = null
  loading.value = true
  error.value = ''
  preview.value = null
  try {
    if (!props.collectionId) {
      model.value = { expectedAclVersion: 1, visibility: 'public', viewerIds: [], passwordAction: 'keep', passwordExemptMode: 'none', passwordExemptUserIds: [], reason: t('permissions.createReason') }
      inherited.value = []; editable.value = true
      return
    }
    const dto: any = await $fetch(`/api/admin/collections/${props.collectionId}/access`)
    if (run !== request) return
    inherited.value = dto.inheritedConstraints
    editable.value = dto.capabilities.canEditAccess
    model.value = { expectedAclVersion: dto.aclVersion, visibility: dto.visibility, viewerIds: dto.viewerIds, passwordAction: 'keep', passwordExemptMode: dto.passwordExemptMode, passwordExemptUserIds: dto.passwordExemptUserIds, reason: '' }
  } catch (e: any) { if (run === request) error.value = e?.data?.message || e.message }
  finally { if (run === request) loading.value = false }
}
async function runPreview() {
  if (!props.collectionId || !model.value || previewUsers.value.length > 1) return
  const currentRequest = request
  const run = ++previewRequest
  previewLoading.value = true; previewError.value = ''; preview.value = null
  try {
    const result = await $fetch(`/api/admin/collections/${props.collectionId}/access/preview`, { method: 'POST', body: { access: model.value, userId: previewUsers.value[0] ?? null, context: previewContext.value } })
    if (currentRequest === request && run === previewRequest) preview.value = result
  } catch (e: any) { if (currentRequest === request && run === previewRequest) previewError.value = e?.data?.message || e.message }
  finally { if (run === previewRequest) previewLoading.value = false }
}
watch([model, previewUsers, previewContext], () => { previewRequest++; preview.value = null; previewError.value = ''; previewLoading.value = false }, { deep: true, flush: 'sync' })
watch(() => props.collectionId, load, { immediate: true })
watch(() => model.value?.visibility, value => { if (model.value && value !== 'selected') model.value.viewerIds = [] })
watch(() => model.value?.passwordExemptMode, value => { if (model.value && value !== 'selected') model.value.passwordExemptUserIds = [] })
watch(() => model.value?.passwordAction, value => {
  if (!model.value) return
  if (value !== 'set') delete model.value.newPassword
  if (value === 'clear') { model.value.passwordExemptMode = 'none'; model.value.passwordExemptUserIds = [] }
})
onBeforeUnmount(() => { request++; previewRequest++ })
defineExpose({ reload: load })
</script>

<template>
  <div class="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
    <p v-if="loading">{{ $t('permissions.loading') }}</p>
    <div v-else-if="error" role="alert"><p class="text-red-600">{{ error }}</p><UButton type="button" @click="load">{{ $t('permissions.reload') }}</UButton></div>
    <p v-else-if="!editable">{{ $t('permissions.personalPartition') }}</p>
    <template v-else-if="model">
      <UFormField :label="$t('permissions.visibility')"><USelect v-model="model.visibility" :items="levels" class="w-full" /></UFormField>
      <UserPicker v-if="model.visibility === 'selected'" v-model="model.viewerIds" regular-only />
      <p class="text-xs text-neutral-500">{{ $t('permissions.intersectionHint') }}</p>
      <UFormField :label="$t('permissions.password')"><USelect v-model="model.passwordAction" :items="passwordActions" class="w-full" /></UFormField>
      <UInput v-if="model.passwordAction === 'set'" v-model="model.newPassword" type="password" autocomplete="new-password" :maxlength="128" class="w-full" :placeholder="$t('permissions.newPassword')" />
      <template v-if="model.passwordAction !== 'clear'">
        <UFormField :label="$t('permissions.exempt')"><USelect v-model="model.passwordExemptMode" :items="exemptionModes" class="w-full" /></UFormField>
        <UserPicker v-if="model.passwordExemptMode === 'selected'" v-model="model.passwordExemptUserIds" regular-only />
        <p class="text-xs text-neutral-500">{{ $t('permissions.exemptHint') }}</p>
      </template>
      <ul v-if="inherited.length" class="space-y-1 text-xs text-amber-700 dark:text-amber-400">
        <li v-for="parent in inherited" :key="parent.collectionId">{{ parent.path || '/' }} · {{ $t(`permissions.${parent.visibility}`) }}{{ parent.passwordProtected ? ' 🔒' : '' }}</li>
      </ul>
      <UFormField :label="$t('permissions.reason')" required><UInput v-model="model.reason" class="w-full" :maxlength="1000" /></UFormField>
      <div v-if="collectionId" class="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-700">
        <p class="text-sm">{{ $t('permissions.previewHint') }}</p>
        <UserPicker v-model="previewUsers" single />
        <USelect v-model="previewContext" :items="[{value:'front',label:$t('permissions.previewFront')},{value:'manage',label:$t('permissions.previewManage')}]" />
        <UButton type="button" variant="outline" :loading="previewLoading" :disabled="previewUsers.length > 1 || !model.reason.trim()" @click="runPreview">{{ $t('permissions.preview') }}</UButton>
        <p v-if="previewError" class="text-red-600" role="alert">{{ previewError }}</p>
        <p v-if="preview" class="text-sm">{{ $t(preview.canEnterAudience ? 'permissions.previewAllowed' : 'permissions.previewDenied') }} · {{ preview.passwordProtected ? $t('permissions.previewPassword') : $t('permissions.previewNoPassword') }} · {{ $t('permissions.previewCounts', { visible: preview.visibleCount, blocked: preview.blockedCount, total: preview.sampled }) }}{{ preview.hasMore ? ' +' : '' }}</p>
        <p v-if="preview?.blockReasons" class="text-xs text-neutral-500">{{ $t('permissions.previewReasons', preview.blockReasons) }}</p>
      </div>
    </template>
  </div>
</template>
