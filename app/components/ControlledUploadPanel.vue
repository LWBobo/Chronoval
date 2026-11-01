<script setup lang="ts">
import { createUploadId, putUploadPart } from '~/utils/controlled-upload'
const props = defineProps<{ admin?: boolean; ownerUserId?: number | null; disabled?: boolean; maxFileBytes?: number; remainingBytes?: number | null }>()
const emit = defineEmits<{ uploaded: [] }>()
const { t } = useI18n()
const { user } = useUserSession()
const stripLocation = ref(false)
const visibility = ref<'private' | 'public' | 'shared'>('private'), recipients = ref<number[]>([]), pair = ref(false), folder = ref(false)
const selected = ref<File[]>([]), error = ref(''), running = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const selectedBytes = computed(() => selected.value.reduce((sum, file) => sum + file.size, 0))
type UploadItem = { key: string; files: File[]; filenames: string[]; restored?: boolean; upload: Record<string, unknown>; ownerUserId?: number | null; sessionId?: string; photoId?: string; committed?: boolean; status: string; percentage: number; error?: string; controller?: AbortController }
const items = ref<UploadItem[]>([])
let disposed = false
let poll: ReturnType<typeof setInterval> | undefined, polling = false
function applySession(item: UploadItem, session: any) {
  // A response started before finalization must never undo a confirmed commit.
  if (item.committed && session.state !== 'committed') return
  item.photoId = session.photoId; item.committed = session.state === 'committed'
  if (item.committed) {
    item.percentage = 100
    item.status = session.photo?.status === 'ready' ? 'success' : session.photo?.status === 'failed' ? 'failed' : 'processing'
    item.error = session.photo?.errorCode || undefined
  } else if (['cancelled', 'expired'].includes(session.state)) item.status = 'cancelled'
}
const isVideo = (file: File) => file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(file.name)
function selectFiles(event: Event) { selected.value = Array.from((event.target as HTMLInputElement).files ?? []); error.value = '' }
watch(folder, () => { selected.value = []; error.value = '' })
async function run(item: UploadItem) {
  if (item.status === 'cancelled' || disposed) return
  item.controller = new AbortController()
  item.status = 'uploading'; item.error = undefined
  try {
    if (props.disabled || (props.admin && item.ownerUserId === undefined)) throw new Error(t('accounts.ownerRequired'))
    const session: any = props.admin
      ? await $fetch('/api/admin/uploads/sessions', { method: 'POST', body: { ownerUserId: item.ownerUserId, upload: item.upload } })
      : await $fetch('/api/uploads/sessions', { method: 'POST', body: item.upload })
    item.sessionId = session.id
    applySession(item, session)
    if (item.committed) { emit('uploaded'); return }
    if (item.status === 'cancelled') return
    if (disposed || item.controller.signal.aborted) { await $fetch(`/api/uploads/sessions/${session.id}/cancel`, { method: 'POST' }); throw new DOMException('Aborted', 'AbortError') }
    for (let index = 0; index < item.files.length; index++) {
      const part = session.parts.find((value: any) => value.role === (index ? 'live_video' : 'original'))
      if (!part) throw new Error('Upload part missing')
      await putUploadPart(item.files[index]!, part.url, value => { item.percentage = Math.round((index + value / 100) * 100 / item.files.length) }, item.controller.signal)
    }
    const completed = await $fetch(`/api/uploads/sessions/${session.id}/complete`, { method: 'POST' })
    applySession(item, completed)
    emit('uploaded')
  } catch (e: any) {
    if (item.sessionId) { try { applySession(item, await $fetch(`/api/uploads/sessions/${item.sessionId}`)) } catch {} }
    if (!item.committed && item.status !== 'cancelled') {
      item.status = e.name === 'AbortError' ? 'cancelled' : 'failed'
      item.error = e.name === 'AbortError' ? undefined : e?.data?.message || e.message
    }
  }
}
async function submit() {
  error.value = ''
  if (!selected.value.length || props.disabled || running.value) return
  if (visibility.value === 'shared' && !recipients.value.length && !(props.admin && props.ownerUserId === null)) { error.value = t('accounts.recipientRequired'); return }
  running.value = true
  try {
    let groups: File[][]
    if (pair.value) {
      const picture = selected.value.filter(file => !isVideo(file)), clip = selected.value.filter(isVideo)
      if (picture.length !== 1 || clip.length !== 1) { error.value = t('accounts.pairHint'); return }
      groups = [[picture[0]!, clip[0]!]]
    } else groups = selected.value.map(file => [file])
    const batch: UploadItem[] = groups.map(files => {
      const key = createUploadId()
      const site = props.admin && props.ownerUserId === null
      return { key, files, filenames: files.map(file => file.name), ownerUserId: props.ownerUserId, status: 'pending', percentage: 0,
        upload: { idempotencyKey: key, stripLocation: stripLocation.value, visibility: site ? 'private' : visibility.value,
          recipientIds: site || visibility.value !== 'shared' ? [] : [...recipients.value],
          parts: files.map((file, index) => ({ role: index ? 'live_video' : 'original', relativePath: file.webkitRelativePath || file.name, size: file.size, mime: file.type || 'application/octet-stream' })) } }
    })
    items.value.push(...batch)
    // Access the reactive instances so progress callbacks trigger rendering.
    const pending = items.value.slice(-batch.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (next < pending.length && !disposed) { const item = pending[next++]!; await run(item) }
    }))
    selected.value = []
    if (fileInput.value) fileInput.value.value = ''
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || t('accounts.upload_failed')
  } finally {
    running.value = false
  }
}
async function cancel(item: UploadItem) {
  if (item.committed) return
  if (item.status === 'pending' && !item.sessionId) { item.status = 'cancelled'; return }
  item.controller?.abort()
  if (item.sessionId && !['processing', 'cancelled'].includes(item.status)) {
    try { await $fetch(`/api/uploads/sessions/${item.sessionId}/cancel`, { method: 'POST' }); if (!item.committed) item.status = 'cancelled' }
    catch (e: any) {
      // Finalization may have committed just before cancellation arrived.
      try { applySession(item, await $fetch(`/api/uploads/sessions/${item.sessionId}`)) } catch {}
      if (!item.committed) item.error = e?.data?.message || e.message
    }
  }
}
async function retry(item: UploadItem) {
  if (running.value || item.status !== 'failed') return
  running.value = true
  try {
    if (item.committed && item.photoId) {
      await $fetch(`${props.admin ? '/api/admin/photos' : '/api/me/photos'}/${item.photoId}/retry`, { method: 'POST', body: {} })
      item.status = 'processing'; item.error = undefined
    } else await run(item)
  } catch(e: any) { item.error = e?.data?.message || e.message }
  finally { running.value = false }
}
onMounted(() => {
  void (async () => {
    if (props.admin && props.ownerUserId === undefined) return
    try {
      const response: any = await $fetch('/api/uploads/sessions', { query: { ownerUserId: props.admin ? props.ownerUserId === null ? 'site' : props.ownerUserId : undefined } })
      if (disposed) return
      for (const session of response.items) {
        if (items.value.some(item => item.sessionId === session.id)) continue
        const item: UploadItem = { key: session.id, files: [], filenames: session.parts.map((part: any) => part.filename), restored: true, upload: {}, ownerUserId: props.ownerUserId, sessionId: session.id, status: 'pending', percentage: 0 }
        applySession(item, session); items.value.push(item)
      }
    } catch (e: any) { if (!disposed) error.value = e?.data?.message || e.message }
  })()
  poll = setInterval(async () => {
    if (polling || document.hidden || disposed) return
    polling = true
    try {
      for (const item of items.value.filter(value => value.sessionId && value.status === 'processing')) {
        const previous = item.status
        applySession(item, await $fetch(`/api/uploads/sessions/${item.sessionId}`))
        if (item.status !== previous) emit('uploaded')
      }
    } catch (e: any) { error.value = e?.data?.message || e.message }
    finally { polling = false }
  }, 3000)
})
onBeforeUnmount(() => { disposed = true; clearInterval(poll); for (const item of items.value) if (!item.restored && ['pending', 'uploading'].includes(item.status)) void cancel(item) })
</script>

<template>
  <section class="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
    <h2 class="font-semibold">{{ $t('accounts.upload') }} · {{ $t(admin && ownerUserId === null ? 'accounts.siteOwnership' : 'accounts.personalOwnership') }}</h2>
    <p class="text-xs text-neutral-500">{{ $t('accounts.originalHint') }}</p>
    <p v-if="!admin" class="text-xs text-neutral-500">{{ $t('accounts.uploadDirectory') }}: photos/{{ user?.username }}/</p>
    <p class="text-xs text-neutral-500">{{ $t('accounts.uploadLimits', { max: ((maxFileBytes || 256 * 1024 ** 2) / 1024 ** 2).toFixed(0), selected: (selectedBytes / 1024 ** 2).toFixed(1) }) }}<span v-if="remainingBytes != null"> · {{ $t('accounts.remainingSpace', { size: (remainingBytes / 1024 ** 2).toFixed(1) }) }}</span></p>
    <fieldset :disabled="disabled || running" class="space-y-3">
      <div class="flex flex-wrap gap-4"><UCheckbox v-model="folder" :label="$t('accounts.directoryUpload')" /><UCheckbox v-model="pair" :label="$t('accounts.pairUpload')" /></div>
      <div class="rounded-lg border-2 border-dashed border-neutral-300 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900">
        <input ref="fileInput" :key="String(folder)" type="file" multiple :aria-label="$t('accounts.upload')" :webkitdirectory="folder ? '' : undefined" :directory="folder ? '' : undefined" accept="image/*,video/*,.heic,.heif,.dng,.arw,.nef,.cr2,.cr3,.mov" class="block w-full min-w-0 cursor-pointer text-sm file:me-3 file:cursor-pointer file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-4 file:py-2 file:text-neutral-900 hover:file:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary disabled:cursor-not-allowed dark:file:border-neutral-600 dark:file:bg-neutral-800 dark:file:text-neutral-100 dark:hover:file:bg-neutral-700" @change="selectFiles" />
        <ul v-if="selected.length" class="mt-3 max-h-32 space-y-1 overflow-y-auto text-xs text-neutral-500">
          <li v-for="(file, index) in selected" :key="index" class="break-all">{{ file.webkitRelativePath || file.name }}</li>
        </ul>
      </div>
      <p v-if="pair" class="text-xs text-neutral-500">{{ $t('accounts.pairHint') }}</p>
      <template v-if="!(admin && ownerUserId === null)">
        <USelect v-model="visibility" :items="['private','public','shared'].map(value => ({ value, label: $t(`accounts.visibility_${value}`) }))" class="w-full" />
        <UserPicker v-if="visibility === 'shared'" v-model="recipients" :exclude-id="admin ? ownerUserId ?? undefined : user?.id" />
      </template>
      <UCheckbox v-model="stripLocation" :label="$t('accounts.stripLocation')" />
      <UButton type="button" :disabled="disabled || !selected.length" :loading="running" @click="submit">{{ $t('accounts.startUpload') }} ({{ selected.length }})</UButton>
    </fieldset>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <ul class="space-y-2"><li v-for="item in items" :key="item.key" class="rounded bg-neutral-100 p-2 text-sm dark:bg-neutral-900"><div class="flex flex-wrap items-center justify-between gap-2"><span class="break-all">{{ item.filenames.join(' + ') }} · {{ $t(`accounts.upload_${item.status}`) }} {{ item.percentage }}%</span><UButton v-if="item.status === 'failed' && (item.committed || item.files.length)" size="xs" variant="ghost" :disabled="running" @click="retry(item)">{{ $t('accounts.retry') }}</UButton><UButton v-if="!item.committed && ['uploading','failed','pending'].includes(item.status)" size="xs" variant="ghost" @click="cancel(item)">{{ $t('accounts.cancel') }}</UButton></div><p v-if="item.restored && !item.committed" class="text-neutral-500">{{ $t('accounts.reselectFiles') }}</p><p v-if="item.error" class="text-red-600">{{ item.error }}</p></li></ul>
  </section>
</template>
