import type { H3Event } from 'h3'
import { settingsManager } from '../services/settings/settingsManager'
import { normalizeSiteUrl, resolveRequestOrigin } from '../utils/site-url'

interface SiteConfigStackInitCtx {
  siteConfig: {
    push: (input: Record<string, unknown>) => void
  }
  event: H3Event
}

export default defineNitroPlugin(async (nitroApp) => {
  // nuxt-site-config 在生产环境会把非 localhost 主机的协议强制改成 https。
  // site-config:init 会等待本 hook 返回的 Promise：已配置的站点地址保留其协议；
  // 未配置时改用本次请求的可信来源（转发头仅接受受信任代理），避免规范地址停留在 https。
  nitroApp.hooks.hook('site-config:init', (ctx: SiteConfigStackInitCtx) => {
    return settingsManager
      .get<string>('app', 'siteUrl')
      .catch((error) => {
        console.warn('[site-url] 同步站点地址到 site-config 失败:', error)
        return ''
      })
      .then((siteUrl) => {
        const configured: string =
          normalizeSiteUrl(siteUrl?.trim() || '') ||
          normalizeSiteUrl(process.env.NUXT_PUBLIC_SITE_URL || '')
        const canonical = configured || resolveRequestOrigin(ctx.event)
        if (!canonical) return
        ctx.siteConfig.push({
          _context: configured ? 'chronoval:app-site-url' : 'chronoval:request-origin',
          _priority: 1, // 高于 nitro(-4) / runtime(0)，保证覆盖默认协议推导
          url: canonical,
        })
        ctx.event.context.siteConfigNitroOrigin = canonical
        console.info(
          `[site-url] site-config 栈 + nitroOrigin 已应用规范地址: ${canonical}`,
        )
      })
  })

  // 只把站点规范地址同步到公共运行时配置。Host 白名单属于服务端安全配置，
  // 不写入 runtimeConfig.public，避免被客户端配置载荷公开。
  try {
    const publicConfig = useRuntimeConfig().public as Record<string, unknown>

    // Nuxt 在生产环境会冻结 public runtime config（不可写），写入会抛
    // "Cannot assign to read only property"。实际运行时（host-guard、
    // resolveSiteUrl）均直接经 settingsManager 读取，不依赖该 public 字段，
    // 因此这里做冻结安全写入：可写则同步，只读则静默跳过。
    const assignPublic = <T,>(key: string, value: T): void => {
      if (!Object.isExtensible(publicConfig)) return
      try {
        ;(publicConfig as Record<string, T>)[key] = value
      } catch {
        /* 冻结只读时不报错，运行期逻辑不依赖此字段 */
      }
    }

    const siteUrl: string =
      (await settingsManager.get<string>('app', 'siteUrl'))?.trim() ||
      process.env.NUXT_PUBLIC_SITE_URL ||
      ''

    const allowedHosts: string =
      (await settingsManager.get<string>('app', 'allowedHosts'))?.trim() ||
      process.env.NUXT_ALLOWED_HOSTS ||
      ''

    const canonical: string = normalizeSiteUrl(siteUrl)
    assignPublic('siteUrl', canonical)

    if (canonical) {
      const afterScheme = canonical.replace(/^[a-z]+:\/\//i, '')
      const hostWithPath = afterScheme.split('/').shift()!
      const siteHost = hostWithPath.split(':').shift()!
      console.info(
        `[site-url] 站点规范地址已配置: ${canonical}` +
          `（允许主机: ${[allowedHosts, siteHost].filter(Boolean).join(', ')}）`,
      )
    }
  } catch (error) {
    console.warn('[site-url] 读取站点配置失败:', error)
  }
})
