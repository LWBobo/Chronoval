import { and, eq } from 'drizzle-orm'
import {
  readCollectionAccess,
  type CollectionAudience,
} from './access-grants'

export type ManualAlbum = typeof tables.collections.$inferSelect & {
  visibility: CollectionAudience
  isHidden: boolean
  hideFromGallery: boolean
  randomWheelAnimation: boolean
  passwordExemptMode: 'logged_in' | 'selected' | null
  passwordExemptUsers: string[]
}

export function toManualAlbum(
  row: typeof tables.collections.$inferSelect,
  db: ReturnType<typeof useDB> | any = useDB(),
): ManualAlbum {
  const access = readCollectionAccess(row.id, db)
  return {
    ...row,
    ...access,
    hideFromGallery: !row.showOnGallery,
    randomWheelAnimation: row.randomAnimation === 'wheel',
  }
}

export function listManualAlbums(): ManualAlbum[] {
  const db = useDB()
  return db
    .select()
    .from(tables.collections)
    .where(eq(tables.collections.kind, 'manual'))
    .all()
    .map((row) => toManualAlbum(row, db))
}

export function getManualAlbumById(id: number): ManualAlbum | null {
  const db = useDB()
  const row = db
    .select()
    .from(tables.collections)
    .where(
      and(
        eq(tables.collections.kind, 'manual'),
        eq(tables.collections.id, id),
      ),
    )
    .get()
  return row ? toManualAlbum(row, db) : null
}

export function getManualAlbumByPublicKey(key: string): ManualAlbum | null {
  const db = useDB()
  const row = /^\d+$/.test(key)
    ? db
        .select()
        .from(tables.collections)
        .where(
          and(
            eq(tables.collections.kind, 'manual'),
            eq(tables.collections.id, Number(key)),
          ),
        )
        .get()
    : db
        .select()
        .from(tables.collections)
        .where(
          and(
            eq(tables.collections.kind, 'manual'),
            eq(tables.collections.uid, key),
          ),
        )
        .get()
  return row ? toManualAlbum(row, db) : null
}
