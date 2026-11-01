import { eq } from 'drizzle-orm'
import { tables, useDB } from '../../utils/db'
import type { Actor } from '../../utils/access'
import { assertCurrentActor, audit } from './index'
import { generateTotpSecret, verifyTotp } from '../../utils/totp'

export function prepareTwoFactor(actor: Actor) {
  return useDB().transaction(tx => {
    const user = assertCurrentActor(tx as any, actor)
    if (user.totpEnabled || user.totpSecret) return user
    return tx.update(tables.users).set({ totpSecret: generateTotpSecret(), version: user.version + 1, updatedAt: new Date() }).where(eq(tables.users.id, user.id)).returning().get()!
  }, { behavior: 'immediate' })
}

export function changeTwoFactor(actor: Actor, code: string, enabled: boolean) {
  return useDB().transaction(tx => {
    const user = assertCurrentActor(tx as any, actor)
    if (!user.totpSecret || user.totpEnabled === enabled) throw createError({ statusCode: 409, message: '两步验证状态已改变，请刷新' })
    if (!verifyTotp(user.totpSecret, code)) throw createError({ statusCode: 400, message: '验证码不正确' })
    const next = tx.update(tables.users).set({ totpEnabled: enabled, totpSecret: enabled ? user.totpSecret : null, authVersion: user.authVersion + 1, version: user.version + 1, updatedAt: new Date() }).where(eq(tables.users.id, user.id)).returning().get()!
    audit(tx as any, user.id, enabled ? 'user.enable-2fa' : 'user.disable-2fa', 'user', user.id)
    return next
  }, { behavior: 'immediate' })
}
