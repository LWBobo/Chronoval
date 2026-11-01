<script setup lang="ts">
definePageMeta({ layout: 'personal' })
const session = useUserSession()
const { data: profile, refresh } = await useFetch<{ username: string; email: string; displayName: string }>('/api/me/profile', { key: `account:profile:${session.user.value?.id}` })
const displayName = ref(profile.value?.displayName ?? '')
const password = reactive({ oldPassword: '', password: '', confirm: '' })
const error = ref(''), message = ref(''), busy = ref(false)
const twoFactor = ref(false), setup = ref<{ qr: string | null; secret: string | null } | null>(null), code = ref('')
const logs = ref<Array<{ id: number; loginIdentifier: string; method: string; status: string; ip: string | null; createdAt: string }>>([])
const { t } = useI18n()
async function perform(action: () => Promise<void>) {
  error.value = ''; message.value = ''; busy.value = true
  try { await action(); message.value = t('accounts.saved') }
  catch (e: any) { error.value = e?.data?.message || e.message }
  finally { busy.value = false }
}
async function saveName() {
  await perform(async () => { await $fetch('/api/me/profile', { method: 'PATCH', body: { displayName: displayName.value } }); await refresh(); await session.fetch() })
}
async function savePassword() {
  await perform(async () => {
    if (password.password.length < 12 || password.password.length > 128 || password.password !== password.confirm) throw new Error(t('accounts.passwordRules'))
    await $fetch('/api/me/password', { method: 'POST', body: { oldPassword: password.oldPassword, password: password.password } })
    password.oldPassword = ''; password.password = ''; password.confirm = ''
    await session.fetch(); await refresh(); await loadSecurity()
  })
}
async function loadSecurity() {
  if (session.user.value?.mustChangePassword) return
  try {
    twoFactor.value = (await $fetch<{ enabled: boolean }>('/api/auth/2fa/status')).enabled
    logs.value = await $fetch('/api/auth/login-logs', { query: { limit: 50 } }) as any
  } catch (e: any) { error.value = e?.data?.message || e.message }
}
async function setupTwoFactor() {
  await perform(async () => { setup.value = await $fetch('/api/auth/2fa/setup', { method: 'POST' }) as any })
}
async function changeTwoFactor() {
  await perform(async () => {
    await $fetch(`/api/auth/2fa/${twoFactor.value ? 'disable' : 'confirm'}`, { method: 'POST', body: { code: code.value } })
    code.value = ''; setup.value = null
    await session.fetch(); await loadSecurity()
  })
}
onMounted(loadSecurity)
onBeforeUnmount(() => { setup.value = null; password.oldPassword = ''; password.password = ''; password.confirm = ''; code.value = '' })
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <h1 class="text-2xl font-semibold">{{ $t('accounts.security') }}</h1>
    <UAlert v-if="session.user.value?.mustChangePassword" color="warning" :title="$t('accounts.forcePassword')" />
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p><p v-if="message" class="text-green-700" role="status">{{ message }}</p>
    <form class="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" @submit.prevent="saveName">
      <p>{{ $t('accounts.username') }}: {{ profile?.username }} · {{ profile?.email }}</p>
      <p class="text-sm text-neutral-500">{{ $t('accounts.usernameFixed') }}</p>
      <UFormField :label="$t('accounts.displayName')"><UInput v-model="displayName" class="w-full" :maxlength="64" required /></UFormField>
      <UButton type="submit" :loading="busy">{{ $t('accounts.save') }}</UButton>
    </form>
    <form class="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" @submit.prevent="savePassword">
      <h2 class="font-semibold">{{ $t('accounts.changePassword') }}</h2>
      <UFormField :label="$t('accounts.oldPassword')"><UInput v-model="password.oldPassword" type="password" autocomplete="current-password" class="w-full" required /></UFormField>
      <UFormField :label="$t('accounts.newPassword')"><UInput v-model="password.password" type="password" autocomplete="new-password" :minlength="12" :maxlength="128" class="w-full" required /></UFormField>
      <UFormField :label="$t('accounts.confirmPassword')"><UInput v-model="password.confirm" type="password" autocomplete="new-password" class="w-full" required /></UFormField>
      <p class="text-xs text-neutral-500">{{ $t('accounts.passwordRules') }}</p><UButton type="submit" :loading="busy">{{ $t('accounts.save') }}</UButton>
    </form>
    <section v-if="!session.user.value?.mustChangePassword" class="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 class="font-semibold">{{ $t('accounts.twoFactor') }} · {{ $t(twoFactor ? 'accounts.enabled' : 'accounts.disabled') }}</h2>
      <UButton v-if="!twoFactor && !setup" :loading="busy" @click="setupTwoFactor">{{ $t('accounts.enable') }}</UButton>
      <template v-if="setup"><img v-if="setup.qr" :src="setup.qr" alt="TOTP QR" width="240" height="240" /><p class="break-all font-mono">{{ setup.secret }}</p></template>
      <form v-if="twoFactor || setup" class="flex flex-wrap gap-2" @submit.prevent="changeTwoFactor"><UInput v-model="code" autocomplete="one-time-code" inputmode="numeric" :maxlength="8" :placeholder="$t('accounts.code')" required /><UButton type="submit" :loading="busy" :color="twoFactor ? 'error' : 'primary'">{{ $t(twoFactor ? 'accounts.disable' : 'accounts.confirm') }}</UButton></form>
      <h2 class="pt-4 font-semibold">{{ $t('accounts.loginLogs') }}</h2>
      <div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead><tr><th>{{ $t('accounts.identifier') }}</th><th>{{ $t('accounts.status') }}</th><th>IP</th><th>{{ $t('accounts.time') }}</th></tr></thead><tbody><tr v-for="log in logs" :key="log.id"><td class="py-2">{{ log.loginIdentifier }} · {{ log.method }}</td><td>{{ log.status }}</td><td>{{ log.ip }}</td><td>{{ new Date(log.createdAt).toLocaleString() }}</td></tr></tbody></table></div>
    </section>
  </div>
</template>
