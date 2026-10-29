import type { H3Event } from 'h3'
import { settingsManager } from '../services/settings/settingsManager'
import { getActor, type Actor } from './access'

/**
 * 管理员是否免输相簿密码。只读系统开关 scanAlbum.adminBypass，
 * 普通相簿与扫描相簿共用，避免各接口各自读一遍。
 */
export async function isAlbumAdminBypass(
  event: H3Event,
  actor?: Actor,
): Promise<boolean> {
  const who = actor ?? (await getActor(event))
  if (!who.isAdmin) return false
  return Boolean(
    await settingsManager.get<boolean>(
      'system',
      'scanAlbum.adminBypass',
      false,
    ),
  )
}

/**
 * 去掉密码哈希与免密名单。数据库不再保存或回显明文密码。
 */
export function redactAlbumSecrets<T extends Record<string, any>>(
  row: T,
  reveal: boolean,
): Omit<T, 'passwordHash' | 'passwordExemptMode' | 'passwordExemptUsers'> &
  Partial<Pick<T, 'passwordExemptMode' | 'passwordExemptUsers'>> {
  const {
    passwordHash: _hash,
    passwordExemptMode,
    passwordExemptUsers,
    ...rest
  } = row
  if (!reveal) return rest
  return {
    ...rest,
    passwordExemptMode,
    passwordExemptUsers,
  }
}
