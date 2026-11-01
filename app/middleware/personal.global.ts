export default defineNuxtRouteMiddleware(to => {
  if (!/^\/me(?:\/|$)/.test(to.path)) return
  const { loggedIn, user } = useUserSession()
  if (!loggedIn.value) return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  if (user.value?.mustChangePassword && to.path !== '/me/settings/security') return navigateTo('/me/settings/security')
})
