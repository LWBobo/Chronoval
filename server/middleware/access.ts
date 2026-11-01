import { settingsManager } from '../services/settings/settingsManager'
import { resolveAccess, requireAccess } from '../utils/access'
import { assertCsrf } from '../utils/csrf'
import { isPublicIconRequest } from '../utils/access-policy'

/**
 * /api 权限入口。策略表见 server/utils/access.ts，未命中的接口要求管理员。
 * 安装向导只在 system.firstLaunch 仍为真时公开，完成后一律拒绝。
 */
export default defineEventHandler(async (event) => {
  const pathname = getRequestURL(event).pathname
  if (!pathname.startsWith('/api/')) return
  setHeader(event, 'Cache-Control', 'private, no-store')
  setHeader(event, 'Vary', 'Cookie')

  if (pathname.startsWith('/api/wizard')) {
    const firstLaunch = await settingsManager.get<boolean>(
      'system',
      'firstLaunch',
      true,
    )
    if (firstLaunch === false) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Install wizard is closed',
      })
    }
  }

  const actor = await requireAccess(event, resolveAccess(event.method, pathname))
  if (actor.user?.mustChangePassword && !isPublicIconRequest(event.method, pathname) && !/^\/api\/(?:me\/(?:password|profile)|profile|auth\/(?:csrf|2fa\/status)|logout|_auth\/session|system\/settings\/all)$/.test(pathname)) {
    throw createError({ statusCode: 403, message: '请先修改初始密码', data: { code: 'PASSWORD_CHANGE_REQUIRED' } })
  }
  await assertCsrf(event)
})
