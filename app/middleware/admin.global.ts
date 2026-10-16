/**
 * 后台页面只允许管理员进入。接口权限以 server/middleware/access.ts 为准，
 * 这里只避免未授权时先渲染后台布局。
 */
export default defineNuxtRouteMiddleware((to) => {
  if (!to.path.startsWith('/dashboard')) return
  const { loggedIn, user } = useUserSession()
  if (loggedIn.value && user.value?.isAdmin) return
  // 已登录但不是管理员时留在页面，由后台布局提示无权限，
  // 避免被登录页的游客守卫送回 /dashboard 形成循环。
  if (loggedIn.value) return
  return navigateTo({
    path: '/login',
    query: { redirect: to.fullPath },
  })
})
