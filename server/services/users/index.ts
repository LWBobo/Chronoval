import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { normalizeEmail, normalizeUsername } from '../../utils/identity'
import { tables, useDB } from '../../utils/db'
import type { Actor } from '../../utils/access'
import { FixedStore } from '../media-files/store'
import { settingsManager } from '../settings/settingsManager'

export const passwordSchema = z.string().min(12).max(128)
export const usernameSchema = z.string().transform((value, ctx) => {
  try { return normalizeUsername(value) } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message })
    return z.NEVER
  }
})
export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(64).optional(),
  email: z.email().transform(normalizeEmail),
  password: passwordSchema.optional(),
  canUpload: z.boolean().default(true),
  quotaBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(20 * 1024 ** 3),
}).strict()

export function audit(db: ReturnType<typeof useDB>, actorId: number, action: string, type: string, id: string | number, data: { reason?: string; ownerId?: number | null; before?: Record<string, unknown>; after?: Record<string, unknown> } = {}) {
  db.insert(tables.auditLogs).values({ actorUserId: actorId, action, targetType: type, targetId: String(id), reason: data.reason, ownerUserId: data.ownerId, beforeJson: data.before, afterJson: data.after }).run()
}

export function userDto(row: typeof tables.users.$inferSelect) {
  return { id: row.id, username: row.username, displayName: row.displayName, email: row.email, role: row.role, status: row.status, canUpload: row.canUpload, mustChangePassword: row.mustChangePassword, quotaBytes: row.storageQuotaBytes, version: row.version, totpEnabled: row.totpEnabled, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

export function assertAdmin(actor: Actor): asserts actor is Actor & { user: NonNullable<Actor['user']> } {
  if (!actor.user || !actor.isAdmin) throw createError({ statusCode: 403, message: 'Admin privileges required' })
}

/** Recheck under the write transaction, including requests delayed by password hashing or storage I/O. */
export function assertCurrentActor(db: ReturnType<typeof useDB>, actor: Actor, admin = false) {
  const row = actor.user ? db.select().from(tables.users).where(eq(tables.users.id, actor.user.id)).get() : null
  if (!row || row.status !== 'active' || row.authVersion !== actor.user?.authVersion || row.mustChangePassword) throw createError({ statusCode: 401, message: '请重新登录' })
  if (admin && row.role !== 'admin') throw createError({ statusCode: 403, message: 'Admin privileges required' })
  return row
}

export async function createAccount(input: z.infer<typeof createUserSchema>, actorId: number | null, role: 'admin' | 'user' = 'user', actor?: Actor) {
  const password = input.password ?? randomBytes(18).toString('base64url')
  const passwordHash = await hashPassword(password)
  try {
    const user = useDB().transaction((tx) => {
      if (actorId !== null) {
        if (!actor || actor.user?.id !== actorId) throw createError({ statusCode: 403, message: 'Admin privileges required' })
        assertCurrentActor(tx as any, actor, true)
      } else if (tx.select({ id: tables.users.id }).from(tables.users).limit(1).get()) {
        throw createError({ statusCode: 409, message: '管理员账号已初始化' })
      }
      const duplicate = tx.select().from(tables.users).where(or(eq(tables.users.usernameKey, input.username), eq(tables.users.emailKey, input.email))).get()
      if (duplicate) throw createError({ statusCode: 409, message: duplicate.usernameKey === input.username ? '用户名已存在，请更换用户名' : '邮箱已存在', data: { code: duplicate.usernameKey === input.username ? 'USERNAME_TAKEN' : 'EMAIL_TAKEN' } })
      const row = tx.insert(tables.users).values({ username: input.username, usernameKey: input.username, displayName: input.displayName ?? input.username, email: input.email, emailKey: input.email, password: passwordHash, role, canUpload: input.canUpload, storageQuotaBytes: input.quotaBytes, mustChangePassword: role !== 'admin', createdBy: actorId, createdAt: new Date() }).returning().get()!
      tx.insert(tables.userStorageUsage).values({ userId: row.id }).run()
      audit(tx as any, actorId ?? row.id, 'user.create', 'user', row.id, { after: { username: row.username, role } })
      return row
    }, { behavior: 'immediate' })
    let storageDirectoryReady = true
    try {
      const provider = await settingsManager.storage.getActiveProvider()
      if (provider) {
        const store = new FixedStore(provider.id)
        if (store.supportsManagedUploads) await store.localPath(`${store.userRoot(user.username)}/.directory-check`, true)
        else storageDirectoryReady = false
      } else storageDirectoryReady = false
    } catch { storageDirectoryReady = false }
    return { user: userDto(user), initialPassword: password, storageDirectoryReady }
  } catch (e: any) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      const nameTaken = useDB().select({ id: tables.users.id }).from(tables.users).where(eq(tables.users.usernameKey, input.username)).get()
      throw createError({ statusCode: 409, message: nameTaken ? '用户名已存在，请更换用户名' : '邮箱已存在', data: { code: nameTaken ? 'USERNAME_TAKEN' : 'EMAIL_TAKEN' } })
    }
    throw e
  }
}

export function readUser(id: number) {
  const row = useDB().select().from(tables.users).where(eq(tables.users.id, id)).get()
  if (!row) throw createError({ statusCode: 404, message: 'User not found' })
  return row
}

export function assertNotLastAdmin(db: ReturnType<typeof useDB>, row: typeof tables.users.$inferSelect) {
  if (row.role !== 'admin' || row.status !== 'active') return
  const admins = db.select({ id: tables.users.id }).from(tables.users).where(and(eq(tables.users.role, 'admin'), eq(tables.users.status, 'active'))).all()
  if (admins.length <= 1) throw createError({ statusCode: 409, message: '不能停用、删除或降级最后一个有效管理员', data: { code: 'LAST_ADMIN' } })
}

export function editAccount(id: number, input: { expectedVersion: number; displayName?: string; email?: string; canUpload?: boolean; quotaBytes?: number | null; role?: 'admin' | 'user'; reason: string }, actor: Actor) {
  assertAdmin(actor)
  return useDB().transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    const row = tx.select().from(tables.users).where(eq(tables.users.id, id)).get()
    if (!row || ['deleted','deleting'].includes(row.status)) throw createError({ statusCode: 404, message: 'User not found' })
    if (row.version !== input.expectedVersion) throw createError({ statusCode: 409, message: '用户已被修改，请刷新重试' })
    if (input.role === 'user') assertNotLastAdmin(tx as any, row)
    if (input.email && input.email !== row.email && tx.select({ id: tables.users.id }).from(tables.users).where(eq(tables.users.emailKey, input.email)).get()) throw createError({ statusCode: 409, message: '邮箱已存在', data: { code: 'EMAIL_TAKEN' } })
    const next = tx.update(tables.users).set({ displayName: input.displayName ?? row.displayName, email: input.email ?? row.email, emailKey: input.email ?? row.emailKey, canUpload: input.canUpload ?? row.canUpload, storageQuotaBytes: input.quotaBytes === undefined ? row.storageQuotaBytes : input.quotaBytes, role: input.role ?? row.role, authVersion: row.authVersion + (input.role && input.role !== row.role ? 1 : 0), version: row.version + 1, updatedAt: new Date() }).where(eq(tables.users.id, id)).returning().get()!
    audit(tx as any, actor.user.id, 'user.update', 'user', id, { reason: input.reason, before: userDto(row), after: userDto(next) })
    return userDto(next)
  }, { behavior: 'immediate' })
}

export async function accountAction(id: number, action: string, input: { expectedVersion: number; reason: string; password?: string }, actor: Actor) {
  assertAdmin(actor)
  const temp = action === 'reset-password' ? input.password ?? randomBytes(18).toString('base64url') : undefined
  const hash = temp ? await hashPassword(temp) : undefined
  const user = useDB().transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    const row = tx.select().from(tables.users).where(eq(tables.users.id, id)).get()
    if (!row || ['deleted', 'deleting'].includes(row.status)) throw createError({ statusCode: 404, message: 'User not found' })
    if (row.version !== input.expectedVersion) throw createError({ statusCode: 409, message: '用户已被修改，请刷新重试' })
    const patch: Partial<typeof tables.users.$inferInsert> = { authVersion: row.authVersion + 1, version: row.version + 1, updatedAt: new Date() }
    switch (action) {
      case 'disable': assertNotLastAdmin(tx as any, row); patch.status = 'disabled'; patch.disabledAt = new Date(); break
      case 'restore': patch.status = 'active'; patch.disabledAt = null; break
      case 'revoke-sessions': break
      case 'reset-password': patch.password = hash; patch.mustChangePassword = true; break
      case 'reset-2fa': patch.totpEnabled = false; patch.totpSecret = null; patch.mustChangePassword = true; break
      default: throw createError({ statusCode: 404, message: 'Unknown account action' })
    }
    const next = tx.update(tables.users).set(patch).where(eq(tables.users.id, id)).returning().get()!
    audit(tx as any, actor.user.id, `user.${action}`, 'user', id, { reason: input.reason, before: { status: row.status }, after: { status: next.status } })
    return userDto(next)
  }, { behavior: 'immediate' })
  return { user, ...(temp ? { initialPassword: temp } : {}) }
}

export function findRecipients(query: string, includeAdmin = false, includeInactive = false) {
  const term = `%${query.replace(/[\\%_]/g, '')}%`
  return useDB().select({ id: tables.users.id, username: tables.users.username, displayName: tables.users.displayName, status: tables.users.status }).from(tables.users).where(and(includeInactive ? undefined : eq(tables.users.status, 'active'), includeAdmin ? undefined : eq(tables.users.role, 'user'), or(like(tables.users.username, term), like(tables.users.displayName, term)))).limit(50).all()
}

export function validateRecipients(db: ReturnType<typeof useDB>, ids: number[], ownerId?: number | null, regularOnly = false) {
  const unique = [...new Set(ids)]
  if (unique.length > 500 || unique.some((id) => !Number.isSafeInteger(id) || id <= 0 || id === ownerId)) throw createError({ statusCode: 422, message: 'Invalid recipients' })
  if (!unique.length) return unique
  const rows = db.select({ id: tables.users.id }).from(tables.users).where(and(inArray(tables.users.id, unique), eq(tables.users.status, 'active'), regularOnly ? eq(tables.users.role, 'user') : undefined)).all()
  if (rows.length !== unique.length) throw createError({ statusCode: 422, message: '接收者不存在、已停用或不可指定' })
  return unique
}
