export function useAccountLogout() {
  const session = useUserSession()
  return async () => {
    await $fetch('/api/logout', { method: 'POST' })
    await session.fetch()
    clearNuxtData(key => key.startsWith('personal:') || key.startsWith('managed:') || key.startsWith('account:'))
    await navigateTo('/')
  }
}
