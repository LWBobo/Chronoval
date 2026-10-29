/**
 * 后台页面只允许管理员进入。接口权限以 server/middleware/access.ts 为准，
 * 这里只避免未授权时先渲染后台布局。
 */
export default defineNuxtRouteMiddleware((to) => {
  if (!/^\/dashboard(?:\/|$)/.test(to.path)) return
  const { loggedIn, user } = useUserSession()
  if (loggedIn.value && user.value?.isAdmin) return
  if (loggedIn.value) return navigateTo('/')
  return navigateTo({
    path: '/login',
    query: { redirect: to.fullPath },
  })
})
