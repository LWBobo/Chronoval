import { useDB, tables, eq, or, and } from '~~/server/utils/db'

// 旧数据库可能仍保留这些设置的 is_public=1。公开接口必须在读取时再次拒绝，
// 不能只依赖初始化配置，否则升级后仍会泄露内部主机、代理和 ML 服务信息。
const PRIVATE_SETTINGS = new Set([
  'app:allowedHosts',
  'system:scanAlbum.adminBypass',
  'system:auth.github.clientSecret',
  'location:nominatim.baseUrl',
  'ml:url',
  'ml:clip.model',
  'ml:face.model',
])

/**
 * 获取所有公开设置
 * 仅返回 isPublic=true 的设置，按命名空间分组
 * 特例：始终返回 system:firstLaunch 以便前端判断是否需要初始化
 */
export default eventHandler(async () => {
  const db = useDB()

  // 查询所有公开设置
  const allSettings = db
    .select()
    .from(tables.settings)
    .where(
      and(
        eq(tables.settings.isSecret, false),
        or(
          eq(tables.settings.isPublic, true),
          and(
            eq(tables.settings.namespace, 'system'),
            eq(tables.settings.key, 'firstLaunch'),
          ),
        ),
      ),
    )
    .all()

  // 按命名空间分组
  const grouped: Record<string, Record<string, any>> = {}

  for (const setting of allSettings) {
    if (PRIVATE_SETTINGS.has(`${setting.namespace}:${setting.key}`)) continue
    if (!grouped[setting.namespace]) {
      grouped[setting.namespace] = {}
    }

    // 解析值
    let value: any = setting.value
    try {
      if (setting.type === 'json') {
        value = setting.value ? JSON.parse(setting.value) : null
      } else if (setting.type === 'number') {
        value = setting.value ? Number(setting.value) : null
      } else if (setting.type === 'boolean') {
        value = setting.value === 'true' || setting.value === '1'
      }
    } catch {
      // 保持原始值
    }

    grouped[setting.namespace][setting.key] = value
  }

  return {
    timestamp: Date.now(),
    data: grouped,
  }
})
