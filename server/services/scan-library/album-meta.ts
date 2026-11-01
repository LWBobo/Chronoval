import { normalizeAlbumPath } from '../../utils/album-path'
import { and, eq } from 'drizzle-orm'
import { parseExemptUsers } from '../../utils/albumPasswordExempt'
import type { ScanAlbumNode } from './manager'
import {
  readCollectionAccess,
  replaceCollectionAccess,
} from '../collections/access-grants'
import { syncFolderCollection } from '../collections/sync-folder'
import { collectionAccessSchema, replaceCollectionPolicy } from '../collections/access'
import type { Actor } from '../../utils/access'
import type { z } from 'zod'

export type RandomAnimationMode = 'default' | 'wheel' | 'compat'

export interface ScanAlbumMetaRow {
  id: number
  mount: string
  relPath: string
  title: string | null
  description: string | null
  coverPhotoId: string | null
  isHidden: boolean
  visibility: 'public' | 'login' | 'selected' | 'admin'
  passwordHash: string | null
  passwordExemptMode: 'logged_in' | 'selected' | null
  passwordExemptUsers: string[]
  slug: string | null
  urlKey: string | null
  bgmMusicId: number | null
  layout: 'waterfall' | 'grid' | 'immersive' | 'timeline'
  randomWheelAnimation: boolean
  randomAnimation: RandomAnimationMode
  randomQuotesEnabled: boolean
  randomQuotes: string | null
  randomQuotesTag: 'ancient' | 'modern' | null
  createdAt: Date
  updatedAt: Date
}

export interface ScanAlbumMetaInput {
  mount: string
  relPath: string
  title?: string | null
  description?: string | null
  coverPhotoId?: string | null
  access?: z.infer<typeof collectionAccessSchema>
  slug?: string | null
  urlKey?: string | null
  layout?: 'waterfall' | 'grid' | 'immersive' | 'timeline'
  randomWheelAnimation?: boolean
  randomAnimation?: RandomAnimationMode
  randomQuotesEnabled?: boolean
  randomQuotes?: string | null
  randomQuotesTag?: 'ancient' | 'modern' | null
  bgmMusicId?: number | null
}

const cleanRelPath = normalizeAlbumPath

const libraryIdOfMount = (mount: string): number | null => {
  const match = /^scan_(\d+)$/.exec(mount)
  return match ? Number(match[1]) : null
}

function toMeta(row: typeof tables.collections.$inferSelect): ScanAlbumMetaRow {
  const access = readCollectionAccess(row.id)
  return {
    id: row.id,
    mount: `scan_${row.libraryId}`,
    relPath: row.relPath,
    title: row.title,
    description: row.description,
    coverPhotoId: row.coverPhotoId,
    isHidden: access.isHidden,
    visibility: access.visibility,
    passwordHash: row.passwordHash,
    passwordExemptMode: access.passwordExemptMode,
    passwordExemptUsers: access.passwordExemptUsers,
    slug: row.slug,
    urlKey: row.urlKey,
    bgmMusicId: row.bgmMusicId,
    layout: row.layout,
    randomWheelAnimation: row.randomAnimation === 'wheel',
    randomAnimation: row.randomAnimation,
    randomQuotesEnabled: row.randomQuotesEnabled,
    randomQuotes: row.randomQuotes,
    randomQuotesTag: row.randomQuotesTag,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function folderCollection(mount: string, relPath: string) {
  const libraryId = libraryIdOfMount(mount)
  if (libraryId == null) return null
  return (
    useDB()
      .select()
      .from(tables.collections)
      .where(
        and(
          eq(tables.collections.kind, 'folder'),
          eq(tables.collections.libraryId, libraryId),
          eq(tables.collections.relPath, cleanRelPath(relPath)),
        ),
      )
      .get() ?? null
  )
}

export const getScanAlbumMeta = async (
  mount: string,
  relPath: string,
): Promise<ScanAlbumMetaRow | null> => {
  const row = folderCollection(mount, relPath)
  return row ? toMeta(row) : null
}

export const upsertScanAlbumMeta = (
  input: ScanAlbumMetaInput,
  actor?: Actor,
): ScanAlbumMetaRow => {
  const libraryId = libraryIdOfMount(input.mount)
  if (libraryId == null) {
    throw createError({ statusCode: 404, statusMessage: 'Library not found' })
  }
  const relPath = cleanRelPath(input.relPath)
  const collectionId =
    folderCollection(input.mount, relPath)?.id ??
    syncFolderCollection(input.mount, relPath)
  if (!collectionId) {
    throw createError({ statusCode: 404, statusMessage: 'Library not found' })
  }

  const db = useDB()
  const current = folderCollection(input.mount, relPath)!
  const patch: Partial<typeof tables.collections.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (input.title !== undefined) patch.title = input.title?.trim() || null
  if (input.description !== undefined)
    patch.description = input.description?.trim() || null
  if (input.coverPhotoId !== undefined)
    patch.coverPhotoId = input.coverPhotoId || null
  if (input.slug !== undefined) patch.slug = input.slug?.trim() || null
  if (input.urlKey !== undefined) patch.urlKey = input.urlKey?.trim() || null
  if (input.layout !== undefined) patch.layout = input.layout
  if (input.randomAnimation !== undefined)
    patch.randomAnimation = input.randomAnimation
  else if (input.randomWheelAnimation !== undefined)
    patch.randomAnimation = input.randomWheelAnimation ? 'wheel' : 'default'
  if (input.randomQuotesEnabled !== undefined)
    patch.randomQuotesEnabled = input.randomQuotesEnabled
  if (input.randomQuotes !== undefined)
    patch.randomQuotes = input.randomQuotes || null
  if (input.randomQuotesTag !== undefined)
    patch.randomQuotesTag = input.randomQuotesTag || null
  if (input.bgmMusicId !== undefined) patch.bgmMusicId = input.bgmMusicId

  db.update(tables.collections)
    .set(patch)
    .where(eq(tables.collections.id, collectionId))
    .run()

  if (input.access) {
    if (!actor) throw createError({ statusCode: 403, message: 'Admin privileges required' })
    replaceCollectionPolicy(collectionId, input.access, actor, db)
  }

  return toMeta(folderCollection(input.mount, relPath) ?? current)
}

export const clearScanAlbumMeta = async (
  mount: string,
  relPath: string,
): Promise<boolean> => {
  const row = folderCollection(mount, relPath)
  if (!row) return false
  const db = useDB()
  const library = db
    .select()
    .from(tables.libraries)
    .where(eq(tables.libraries.id, row.libraryId!))
    .get()
  db.update(tables.collections)
    .set({
      title: row.relPath ? row.relPath.split('/').at(-1) : library?.name ?? null,
      description: null,
      coverPhotoId: null,
      bgmMusicId: null,
      slug: null,
      urlKey: row.relPath ? null : library?.urlKey ?? null,
      layout: 'waterfall',
      randomAnimation: 'default',
      randomQuotesEnabled: true,
      randomQuotes: null,
      randomQuotesTag: null,
      updatedAt: new Date(),
    })
    .where(eq(tables.collections.id, row.id))
    .run()
  return true
}

export const getScanAlbumMetaBySlug = async (
  slug: string,
): Promise<ScanAlbumMetaRow | null> => {
  if (!slug) return null
  const row = useDB()
    .select()
    .from(tables.collections)
    .where(
      and(
        eq(tables.collections.kind, 'folder'),
        eq(tables.collections.slug, slug),
      ),
    )
    .get()
  return row ? toMeta(row) : null
}

export const getScanAlbumMetaByUrlKey = async (
  urlKey: string,
): Promise<ScanAlbumMetaRow | null> => {
  if (!urlKey) return null
  const row = useDB()
    .select()
    .from(tables.collections)
    .where(
      and(
        eq(tables.collections.kind, 'folder'),
        eq(tables.collections.urlKey, urlKey),
      ),
    )
    .get()
  return row ? toMeta(row) : null
}

export const applyScanAlbumMeta = async (
  node: ScanAlbumNode,
  photoById: Map<
    string,
    {
      id: string
      thumbnailUrl: string | null
      thumbnailHash: string | null
      aspectRatio: number | null
    }
  >,
): Promise<ScanAlbumNode> => {
  const meta = await getScanAlbumMeta(node.mount, node.relPath)
  if (!meta) return { ...node, external: true }

  const covers = [...node.covers]
  let coverPhotoId = node.coverPhotoId
  if (meta.coverPhotoId) {
    const photo = photoById.get(meta.coverPhotoId)
    if (photo && !covers.some((cover) => cover.id === photo.id)) {
      covers.unshift(photo)
    }
    coverPhotoId = meta.coverPhotoId
  }

  return {
    ...node,
    collectionId: meta.id,
    external: true,
    title: meta.title || node.title,
    description: meta.description,
    isHidden: meta.isHidden,
    visibility: meta.visibility,
    passwordProtected: Boolean(meta.passwordHash || node.passwordProtected),
    passwordExemptMode: meta.passwordExemptMode,
    passwordExemptUsers: parseExemptUsers(meta.passwordExemptUsers),
    coverPhotoId,
    covers,
    urlKey: meta.urlKey || node.urlKey,
    layout: meta.layout,
    randomAnimation: meta.randomAnimation,
    randomQuotesEnabled: meta.randomQuotesEnabled,
    randomQuotes: meta.randomQuotes,
    randomQuotesTag: meta.randomQuotesTag,
    bgmMusicId: meta.bgmMusicId,
    link: !node.relPath
      ? meta.slug
        ? `/albums/s/${encodeURIComponent(meta.slug)}`
        : meta.urlKey
          ? `/albums/scan/${encodeURIComponent(meta.urlKey)}`
          : node.link
      : node.link,
    slug: meta.slug,
    hasCustom: true,
  }
}
