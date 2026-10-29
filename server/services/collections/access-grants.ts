import { eq } from 'drizzle-orm'
import { parseExemptUsers } from '~~/server/utils/albumPasswordExempt'

export type CollectionAudience = 'public' | 'login' | 'admin'
export type PasswordExemptMode = 'logged_in' | 'selected' | null

type DatabaseLike = ReturnType<typeof useDB> | any

export interface CollectionAccess {
  visibility: CollectionAudience
  isHidden: boolean
  passwordExemptMode: PasswordExemptMode
  passwordExemptUsers: string[]
}

export function readCollectionAccess(
  collectionId: number,
  db: DatabaseLike = useDB(),
): CollectionAccess {
  const grants = db
    .select({
      audience: tables.accessGrants.audience,
      userId: tables.accessGrants.userId,
      email: tables.users.email,
    })
    .from(tables.accessGrants)
    .leftJoin(tables.users, eq(tables.accessGrants.userId, tables.users.id))
    .where(eq(tables.accessGrants.collectionId, collectionId))
    .all() as Array<{
      audience: 'public' | 'login' | 'admin' | 'user'
      userId: number | null
      email: string | null
    }>

  const visibility = (
    grants.find((grant) => grant.audience === 'admin')?.audience ??
    grants.find((grant) => grant.audience === 'login')?.audience ??
    grants.find((grant) => grant.audience === 'public')?.audience ??
    'public') as CollectionAudience
  const loggedIn = grants.some(
    (grant) => grant.audience === 'user' && grant.userId == null,
  )
  const selected = grants
    .filter(
      (grant) =>
        grant.audience === 'user' && grant.userId != null && grant.email,
    )
    .map((grant) => grant.email!)

  return {
    visibility,
    isHidden: visibility !== 'public',
    passwordExemptMode: loggedIn
      ? 'logged_in'
      : selected.length
        ? 'selected'
        : null,
    passwordExemptUsers: selected,
  }
}

export function replaceCollectionAccess(
  collectionId: number,
  input: {
    visibility: CollectionAudience
    passwordExemptMode?: PasswordExemptMode
    passwordExemptUsers?: string[] | null
  },
  db: DatabaseLike = useDB(),
) {
  db.delete(tables.accessGrants)
    .where(eq(tables.accessGrants.collectionId, collectionId))
    .run()

  db.insert(tables.accessGrants)
    .values({ collectionId, audience: input.visibility })
    .run()

  if (input.passwordExemptMode === 'logged_in') {
    db.insert(tables.accessGrants)
      .values({ collectionId, audience: 'user', userId: null })
      .run()
    return
  }

  if (input.passwordExemptMode !== 'selected') return
  const emails = parseExemptUsers(input.passwordExemptUsers).map((email) =>
    email.toLowerCase(),
  )
  if (!emails.length) return
  const users = db
    .select({ id: tables.users.id, email: tables.users.email })
    .from(tables.users)
    .all() as Array<{ id: number; email: string }>
  const byEmail = new Map(
    users.map((user) => [user.email.toLowerCase(), user.id]),
  )
  const values = emails
    .map((email) => byEmail.get(email))
    .filter((id): id is number => id != null)
    .map((userId) => ({ collectionId, audience: 'user' as const, userId }))
  if (values.length) {
    db.insert(tables.accessGrants).values(values).onConflictDoNothing().run()
  }
}
