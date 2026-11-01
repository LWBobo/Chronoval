export default defineNuxtPlugin(async () => {
  const original = globalThis.$fetch
  let token = (await original<{ token: string }>('/api/auth/csrf')).token
  globalThis.$fetch = original.create({
    async onRequest({ request, options }) {
      const url = new URL(String(request), window.location.origin)
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return
      if (!['GET', 'HEAD', 'OPTIONS'].includes(String(options.method ?? 'GET').toUpperCase())) {
        options.headers.set('X-CSRF-Token', token)
      }
    },
    onResponse({ response }) {
      const next = response.headers.get('X-CSRF-Token')
      if (next) token = next
    },
  })
})
