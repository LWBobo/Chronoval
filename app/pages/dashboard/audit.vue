<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
const items = ref<any[]>([]), cursor = ref<string | null>(null), action = ref(''), actor = ref<number[]>([]), error = ref(''), loading = ref(false)
const owner = ref<number[]>([]), targetType = ref(''), targetId = ref(''), fromDate = ref(''), untilDate = ref('')
let request = 0
function dateQuery(value: string, nextDay = false) { if (!value) return undefined; const date = new Date(`${value}T00:00:00`); if (nextDay) date.setDate(date.getDate()+1); return date.toISOString() }
async function load(more = false) {
  const run = ++request
  loading.value = true; error.value = ''
  try {
    const response: any = await $fetch('/api/admin/audit-logs', {query:{action:action.value || undefined,actorId:actor.value[0],ownerId:owner.value[0],targetType:targetType.value || undefined,targetId:targetId.value || undefined,from:dateQuery(fromDate.value),until:dateQuery(untilDate.value,true),cursor:more ? cursor.value || undefined : undefined}})
    if (run !== request) return
    items.value = more ? [...items.value,...response.items] : response.items; cursor.value = response.nextCursor
  } catch (e: any) { if (run === request) error.value = e?.data?.message || e.message } finally { if (run === request) loading.value = false }
}
onMounted(() => load())
onBeforeUnmount(() => { request++; items.value = [] })
</script>
<template>
  <UDashboardPanel>
    <template #body>
      <div class="space-y-4">
        <h1 class="text-2xl font-semibold">{{ $t('accounts.audit') }}</h1>
        <UFormField :label="$t('accounts.actor')"><UserPicker v-model="actor" single include-inactive /></UFormField>
        <UFormField :label="$t('accounts.owner')"><UserPicker v-model="owner" single include-inactive /></UFormField>
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="load()">
          <UInput v-model="action" :placeholder="$t('accounts.auditAction')" />
          <UInput v-model="targetType" :placeholder="$t('accounts.targetType')" />
          <UInput v-model="targetId" :placeholder="$t('accounts.targetId')" />
          <UFormField :label="$t('accounts.activityFrom')"><UInput v-model="fromDate" type="date" /></UFormField>
          <UFormField :label="$t('accounts.activityUntil')"><UInput v-model="untilDate" type="date" /></UFormField>
          <UButton type="submit" :loading="loading">{{ $t('accounts.search') }}</UButton>
        </form>
        <p v-if="error" class="text-red-600">{{ error }}</p>
        <div v-for="row in items" :key="row.id" class="space-y-1 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <p>{{ row.action }} · {{ row.targetType }} {{ row.targetId }} · {{ $t('accounts.actor') }} {{ row.actorUserId }} · {{ new Date(row.createdAt).toLocaleString() }}</p>
          <p>{{ row.reason }}</p>
          <details><summary>{{ $t('accounts.changes') }}</summary><pre class="overflow-auto whitespace-pre-wrap">{{ JSON.stringify({before:row.beforeJson,after:row.afterJson}, null, 2) }}</pre></details>
        </div>
        <UButton v-if="cursor" :loading="loading" @click="load(true)">{{ $t('accounts.loadMore') }}</UButton>
      </div>
    </template>
  </UDashboardPanel>
</template>
