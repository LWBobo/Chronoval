<script setup lang="ts">
const model = defineModel<number[]>({ required: true })
const props = withDefaults(defineProps<{ regularOnly?: boolean; excludeId?: number | null; single?: boolean; includeInactive?: boolean }>(), { regularOnly: false })
const selection = computed({ get: () => model.value, set: (ids: number[]) => { model.value = props.single ? ids.slice(-1) : ids } })
const query = ref('')
const options = ref<Array<{ id: number; username: string; displayName: string; status: string; role?: string }>>([])
const error = ref('')
let request = 0
let timer: ReturnType<typeof setTimeout> | undefined
async function search() {
  const run = ++request
  try {
    const rows = await $fetch<typeof options.value>('/api/me/recipients', { query: { q: query.value, ids: model.value.join(','), includeAdmin: props.regularOnly ? undefined : '1', includeInactive: props.includeInactive ? '1' : undefined } })
    if (run !== request) return
    const selected = options.value.filter(user => model.value.includes(user.id))
    options.value = [...new Map([...selected, ...rows].filter(user => user.id !== props.excludeId).map(user => [user.id, user])).values()]
    error.value = ''
  } catch (e: any) { if (run === request) error.value = e?.data?.message || e.message }
}
watch(query, () => { clearTimeout(timer); timer = setTimeout(search, 200) })
watch(() => [model.value.join(','), props.excludeId, props.regularOnly, props.includeInactive], search)
onMounted(search)
onBeforeUnmount(() => { request++; clearTimeout(timer) })
</script>

<template>
  <div class="space-y-2">
    <UInput v-model="query" class="w-full" :placeholder="$t('permissions.searchUsers')" />
    <USelectMenu v-model="selection" :items="options" value-key="id" label-key="username" multiple class="w-full" :placeholder="$t('permissions.selectUsers')">
      <template #item-label="{ item }">{{ item.displayName }} ({{ item.username }}){{ item.status !== 'active' ? ` · ${$t(`accounts.status_${item.status}`)}` : '' }}</template>
    </USelectMenu>
    <p class="text-xs text-neutral-500">{{ $t('permissions.selectedCount', { count: model.length }) }} · {{ model.join(', ') }}</p>
    <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
  </div>
</template>
