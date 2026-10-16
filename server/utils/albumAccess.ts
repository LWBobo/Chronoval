import { timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { settingsManager } from '../services/settings/settingsManager'
import { getActor, type Actor } from './access'

export function safeTokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

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
    await settingsManager.get<boolean>('system', 'scanAlbum.adminBypass', false),
  )
}

/**
 * 去掉相簿上的密码与免密名单。reveal 为真时保留明文密码和免密配置（管理端回显）。
 * passwordHash 始终不返回。
 */
export function redactAlbumSecrets<T extends Record<string, any>>(
  row: T,
  reveal: boolean,
): Omit<T, 'passwordHash' | 'password' | 'passwordExemptMode' | 'passwordExemptUsers'> &
  Partial<Pick<T, 'password' | 'passwordExemptMode' | 'passwordExemptUsers'>> {
  const {
    passwordHash: _hash,
    password,
    passwordExemptMode,
    passwordExemptUsers,
    ...rest
  } = row
  if (!reveal) return rest
  return {
    ...rest,
    password,
    passwordExemptMode,
    passwordExemptUsers,
  }
}
