<script setup lang="ts">
import { useAccountLogout } from '~/composables/useAccountLogout'
const { user } = useUserSession()
const logout = useAccountLogout()
const links = [
  { to: '/me/photos', label: 'mine' },
  { to: '/me/shared-by-me', label: 'sharedByMe' },
  { to: '/me/shared-with-me', label: 'sharedWithMe' },
  { to: '/me/trash', label: 'trash' },
  { to: '/me/settings/security', label: 'security' },
]
</script>

<template>
  <div class="min-h-svh bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <header class="border-b border-neutral-200 px-4 py-4 dark:border-neutral-800">
      <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <div><NuxtLink to="/" class="font-semibold">Chronoval</NuxtLink><span class="ml-3 text-sm text-neutral-500">{{ user?.displayName }} ({{ user?.username }})</span></div>
        <div class="flex gap-2"><UButton v-if="user?.isAdmin" to="/dashboard" variant="ghost">{{ $t('accounts.administration') }}</UButton><UButton to="/" variant="ghost">{{ $t('accounts.gallery') }}</UButton><UButton color="neutral" variant="outline" @click="logout">{{ $t('accounts.logout') }}</UButton></div>
      </div>
      <nav class="mx-auto mt-4 flex max-w-7xl flex-wrap gap-2"><UButton v-for="link in links" :key="link.to" :to="link.to" color="neutral" variant="ghost" active-class="bg-neutral-200 dark:bg-neutral-800">{{ $t(`accounts.${link.label}`) }}</UButton></nav>
    </header>
    <main class="mx-auto max-w-7xl px-4 py-6"><slot /></main>
  </div>
</template>
