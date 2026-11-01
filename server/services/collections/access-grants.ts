import { eq } from 'drizzle-orm'
import type { CollectionVisibility } from '../../../shared/types/permissions'
import { collectionAccessDto } from './access'

export type CollectionAudience = CollectionVisibility
export type PasswordExemptMode = 'logged_in' | 'selected' | null
export interface CollectionAccess {
  collectionId: number
  visibility: CollectionAudience
  viewerIds: number[]
  aclVersion: number
  isHidden: boolean
  passwordExemptMode: PasswordExemptMode
  passwordExemptUsers: string[]
}

export function readCollectionAccess(collectionId: number, db: ReturnType<typeof useDB> | any = useDB()): CollectionAccess {
  const dto = collectionAccessDto(collectionId, db)
  const ids = dto.passwordExemptUserIds
  const emails = ids.length ? db.select({ id: tables.users.id, email: tables.users.email }).from(tables.users).all().filter((u: any) => ids.includes(u.id)).map((u: any) => u.email) : []
  return { collectionId, visibility: dto.visibility, viewerIds: dto.viewerIds, aclVersion: dto.aclVersion, isHidden: dto.visibility !== 'public', passwordExemptMode: dto.passwordExemptMode === 'none' ? null : dto.passwordExemptMode, passwordExemptUsers: emails }
}

/** Creation-only initialization. Existing access must use replaceCollectionPolicy. */
export function replaceCollectionAccess(collectionId: number, input: { visibility: CollectionAudience; passwordExemptMode?: PasswordExemptMode; passwordExemptUsers?: string[] | null }, db: ReturnType<typeof useDB> | any = useDB()) {
  const current = db.select().from(tables.collections).where(eq(tables.collections.id, collectionId)).get()
  if (!current || current.aclVersion !== 1 || input.visibility === 'selected' || input.passwordExemptMode || input.passwordExemptUsers?.length) {
    throw createError({ statusCode: 422, message: 'Use the collection access editor' })
  }
  db.update(tables.collections).set({ visibility: input.visibility }).where(eq(tables.collections.id, collectionId)).run()
}
