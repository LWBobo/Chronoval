import { createHmac, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import { tables, useDB } from './db'
import { safeTokenEqual } from './token'
import { folderRows } from '../services/collections/access'
import { useSecureCookie } from './cookie-security'

function signature(input: string) {
  const secret = process.env.NUXT_SESSION_PASSWORD || process.env.NUXT_AUTH_SESSION_PASSWORD
  if (!secret) throw new Error('Session password is not configured')
  return createHmac('sha256', secret).update(input).digest('base64url')
}

export function effectiveCollectionPassword(id: number) {
  const row = useDB().select().from(tables.collections).where(eq(tables.collections.id, id)).get()
  if (!row) return null
  if (row.kind !== 'folder') return row.passwordHash ? row : null
  return folderRows(row.libraryId!, row.relPath).filter((r) => r.passwordHash).at(-1) ?? null
}

export function collectionPasswordAccess(event: H3Event, id: number, adminBypass = false): boolean {
  const row = useDB().select().from(tables.collections).where(eq(tables.collections.id, id)).get()
  if (!row) return false
  if (adminBypass && event.context.permissionActor?.isAdmin) return true
  const origin = effectiveCollectionPassword(id)
  if (!origin) return true
  const userId = Number(event.context.permissionActor?.user?.id) || null
  if (userId && origin.passwordExemptMode === 'logged_in') return true
  if (userId && origin.passwordExemptMode === 'selected' && useDB().select({ id: tables.collectionPasswordExemptions.userId }).from(tables.collectionPasswordExemptions).where(and(eq(tables.collectionPasswordExemptions.collectionId, origin.id), eq(tables.collectionPasswordExemptions.userId, userId))).get()) return true
  const scopes = row.kind === 'folder' ? folderRows(row.libraryId!, row.relPath).filter((r) => r.relPath.length >= origin.relPath.length) : [row]
  const identity = event.context.permissionSessionKey
  if (!identity) return false
  return scopes.some((scope) => {
    const cookie = getCookie(event, `collection_unlock_${scope.id}`)
    if (!cookie) return false
    const [expires, version, token] = cookie.split('.')
    if (!expires || !token || Number(expires) <= Date.now() / 1000 || Number(version) !== origin.passwordVersion) return false
    return safeTokenEqual(token, signature(`${scope.id}:${origin.id}:${version}:${expires}:${identity}`))
  })
}

export async function authorizeCollection(event: H3Event, id: number) {
  const origin = effectiveCollectionPassword(id)
  if (!origin) return
  let session = await getUserSession(event)
  if (!session.csrfToken) {
    await setUserSession(event, { csrfToken: randomBytes(32).toString('hex') })
    session = await getUserSession(event)
  }
  const identity = `${session.user?.id ?? 'guest'}:${session.user?.authVersion ?? 0}:${session.csrfToken}`
  const expires = Math.floor(Date.now() / 1000) + 7200
  const version = origin.passwordVersion
  setCookie(event, `collection_unlock_${id}`, `${expires}.${version}.${signature(`${id}:${origin.id}:${version}:${expires}:${identity}`)}`, { path: '/', httpOnly: true, sameSite: 'lax', secure: useSecureCookie(event), maxAge: 7200 })
}
