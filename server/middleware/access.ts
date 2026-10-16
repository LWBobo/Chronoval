import { settingsManager } from '../services/settings/settingsManager'
import { resolveAccess, requireAccess } from '../utils/access'

/**
 * /api 权限入口。策略表见 server/utils/access.ts，未命中的接口要求管理员。
 * 安装向导只在 system.firstLaunch 仍为真时公开，完成后一律拒绝。
 */
export default defineEventHandler(async (event) => {
  const pathname = getRequestURL(event).pathname
  if (!pathname.startsWith('/api/')) return

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

  await requireAccess(event, resolveAccess(event.method, pathname))
})
