import { normalizeAlbumPath } from '../../utils/album-path'
import { and, eq } from 'drizzle-orm'
import { replaceCollectionAccess } from './access-grants'

function libraryIdOfMount(mount: string): number | null {
  if (!mount.startsWith('scan_')) return null
  const id = Number(mount.slice(5))
  return Number.isInteger(id) && id > 0 ? id : null
}

const cleanRelPath = normalizeAlbumPath

function parentCollectionId(libraryId: number, relPath: string) {
  if (!relPath) return null
  return (
    useDB()
      .select({
        id: tables.collections.id,
        relPath: tables.collections.relPath,
      })
      .from(tables.collections)
      .where(
        and(
          eq(tables.collections.kind, 'folder'),
          eq(tables.collections.libraryId, libraryId),
        ),
      )
      .all()
      .filter(
        (row) =>
          row.relPath !== relPath &&
          (row.relPath === '' || relPath.startsWith(`${row.relPath}/`)),
      )
      .sort((a, b) => b.relPath.length - a.relPath.length)[0]?.id ?? null
  )
}

/** Ensure a canonical folder collection exists for a scanned directory. */
export function syncFolderCollection(mount: string, rawRelPath: string) {
  const libraryId = libraryIdOfMount(mount)
  if (libraryId == null) return null
  const relPath = cleanRelPath(rawRelPath)
  const db = useDB()
  const library = db
    .select()
    .from(tables.libraries)
    .where(eq(tables.libraries.id, libraryId))
    .get()
  if (!library) return null

  const showOnGallery =
    library.displayMode === 'gallery' || library.displayMode === 'both'
  const showOnAlbums =
    library.displayMode === 'album' || library.displayMode === 'both'
  const existing = db
    .select()
    .from(tables.collections)
    .where(
      and(
        eq(tables.collections.kind, 'folder'),
        eq(tables.collections.libraryId, libraryId),
        eq(tables.collections.relPath, relPath),
      ),
    )
    .get()

  if (existing) {
    db.update(tables.collections)
      .set({
        parentId: parentCollectionId(libraryId, relPath),
        showOnGallery,
        showOnAlbums,
        childInParent: library.childInParent,
        childPosition: library.childPosition,
        updatedAt: new Date(),
      })
      .where(eq(tables.collections.id, existing.id))
      .run()
    return existing.id
  }

  const created = db
    .insert(tables.collections)
    .values({
      kind: 'folder',
      libraryId,
      relPath,
      parentId: parentCollectionId(libraryId, relPath),
      title: relPath ? relPath.split('/').at(-1) : library.name,
      urlKey: relPath ? null : library.urlKey,
      showOnGallery,
      showOnAlbums,
      childInParent: library.childInParent,
      childPosition: library.childPosition,
    })
    .returning({ id: tables.collections.id })
    .get()
  replaceCollectionAccess(created.id, { visibility: 'public' }, db)
  return created.id
}

export function syncLibraryFolders(libraryId: number) {
  const mount = `scan_${libraryId}`
  syncFolderCollection(mount, '')
  const rows = useDB()
    .select({ relPath: tables.collections.relPath })
    .from(tables.collections)
    .where(
      and(
        eq(tables.collections.kind, 'folder'),
        eq(tables.collections.libraryId, libraryId),
      ),
    )
    .all()
  for (const row of rows) {
    if (row.relPath) syncFolderCollection(mount, row.relPath)
  }
}

export function removeLibraryCollections(libraryId: number) {
  useDB()
    .delete(tables.libraries)
    .where(eq(tables.libraries.id, libraryId))
    .run()
}
