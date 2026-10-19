import type { H3Event } from 'h3'
import { getDisabledScanMountSet } from '~~/server/services/scan-library/manager'
import { getActor, type Actor } from './access'
import { isAlbumAdminBypass } from './albumAccess'
import { isPasswordExemptForUser } from './albumPasswordExempt'
import { hasAlbumAccess } from './manualAlbumAuth'
import {
  hasScanAlbumAccess,
  hasScanLibraryAccess,
} from './scanAlbumAuth'
import { blockedPhotoIdsForActor } from '~~/server/services/ml/person.service'
import {
  ensureAlbumVisibilityColumn,
  normalizeAlbumVisibility,
} from './albumVisibility'

/**
 * 人员分类、搜索等「发现」入口的可见性。
 * 隐藏相簿（含扫描子相簿）未登录时不参与聚合和搜索，登录后可见。
 * 设了访问密码、且当前会话未解锁的照片不可见。
 * 照片只要还属于一个当前可访问的相簿，就仍然可见。
 */
type AlbumRow = {
  id: number
  isHidden: boolean
  visibility: string | null
  passwordHash: string | null
  passwordExemptMode: string | null
  passwordExemptUsers: string | null
}

type ScanMeta = {
  mount: string
  relPath: string
  isHidden: boolean
  passwordHash: string | null
  passwordExemptMode: string | null
  passwordExemptUsers: string | null
}

export type PhotoAccess = {
  event: H3Event
  actor: Actor
  adminBypass: boolean
  disabledMounts: Set<string>
  albumsByPhoto: Map<string, AlbumRow[]>
  metasByMount: Map<string, ScanMeta[]>
  blockedByPerson: Set<string>
}

const dirOf = (libraryPath: string | null | undefined) => {
  const rel = libraryPath || ''
  const idx = rel.lastIndexOf('/')
  return idx === -1 ? '' : rel.slice(0, idx)
}

const pathInFolder = (dir: string, relPath: string) => {
  if (relPath === '') return true
  return dir === relPath || dir.startsWith(`${relPath}/`)
}

export async function loadPhotoAccess(event: H3Event): Promise<PhotoAccess> {
  const db = useDB()
  const actor = await getActor(event)
  const adminBypass = await isAlbumAdminBypass(event, actor)
  ensureAlbumVisibilityColumn()
  const albums = db
    .select({
      id: tables.albums.id,
      isHidden: tables.albums.isHidden,
      visibility: tables.albums.visibility,
      passwordHash: tables.albums.passwordHash,
      passwordExemptMode: tables.albums.passwordExemptMode,
      passwordExemptUsers: tables.albums.passwordExemptUsers,
    })
    .from(tables.albums)
    .all()
  const albumById = new Map(albums.map((album) => [album.id, album]))
  const links = db
    .select({
      albumId: tables.albumPhotos.albumId,
      photoId: tables.albumPhotos.photoId,
    })
    .from(tables.albumPhotos)
    .all()
  const albumsByPhoto = new Map<string, AlbumRow[]>()
  for (const link of links) {
    const album = albumById.get(link.albumId)
    if (!album) continue
    const list = albumsByPhoto.get(link.photoId)
    if (list) list.push(album)
    else albumsByPhoto.set(link.photoId, [album])
  }
  const metas = db
    .select({
      mount: tables.scanAlbumMeta.mount,
      relPath: tables.scanAlbumMeta.relPath,
      isHidden: tables.scanAlbumMeta.isHidden,
      passwordHash: tables.scanAlbumMeta.passwordHash,
      passwordExemptMode: tables.scanAlbumMeta.passwordExemptMode,
      passwordExemptUsers: tables.scanAlbumMeta.passwordExemptUsers,
    })
    .from(tables.scanAlbumMeta)
    .all()
  const metasByMount = new Map<string, ScanMeta[]>()
  for (const meta of metas) {
    const list = metasByMount.get(meta.mount)
    if (list) list.push(meta)
    else metasByMount.set(meta.mount, [meta])
  }
  for (const list of metasByMount.values()) {
    list.sort((a, b) => b.relPath.length - a.relPath.length)
  }
  return {
    event,
    actor,
    adminBypass,
    disabledMounts: getDisabledScanMountSet(),
    albumsByPhoto,
    metasByMount,
    blockedByPerson: blockedPhotoIdsForActor(actor),
  }
}

function manualAlbumOpen(access: PhotoAccess, album: AlbumRow) {
  const visibility = normalizeAlbumVisibility(album)
  if (visibility === 'admin' && !access.actor.isAdmin) return false
  if (visibility === 'login' && !access.actor.user) return false
  if (!album.passwordHash) return true
  const exempt = isPasswordExemptForUser(album, access.actor.user)
  return hasAlbumAccess(
    access.event,
    {
      albumId: album.id,
      passwordHash: album.passwordHash,
      sessionExempt: exempt,
    },
    access.adminBypass,
  )
}

function scanOpen(access: PhotoAccess, mount: string, libraryPath: string | null) {
  if (access.disabledMounts.has(mount)) return false
  const dir = dirOf(libraryPath)
  const metas = access.metasByMount.get(mount) || []
  const hiddenMeta = metas.find((meta) => pathInFolder(dir, meta.relPath))
  if (hiddenMeta?.isHidden && !access.actor.user) return false
  const passwordMeta = metas.find(
    (meta) => meta.passwordHash && pathInFolder(dir, meta.relPath),
  )
  if (!passwordMeta?.passwordHash) return true
  const libId = Number(String(mount).replace(/^scan_/, ''))
  if (!Number.isFinite(libId)) return false
  const exempt = isPasswordExemptForUser(
    {
      passwordHash: passwordMeta.passwordHash,
      passwordExemptMode: passwordMeta.passwordExemptMode,
      passwordExemptUsers: passwordMeta.passwordExemptUsers,
    },
    access.actor.user,
  )
  const root = metas.find((meta) => meta.relPath === '')
  if (hasScanLibraryAccess(access.event, libId, root?.passwordHash || null)) {
    return true
  }
  return hasScanAlbumAccess(
    access.event,
    {
      libId,
      relPath: dir,
      passwordHash: passwordMeta.passwordHash,
      sessionExempt: exempt,
    },
    access.adminBypass,
  )
}

export function canDiscoverPhoto(
  access: PhotoAccess,
  photo: {
    id: string
    deletedAt?: Date | null
    libraryMount?: string | null
    libraryPath?: string | null
  },
) {
  if (photo.deletedAt) return false
  if (access.blockedByPerson.has(photo.id)) return false
  const albums = access.albumsByPhoto.get(photo.id) || []
  const manualOk = albums.some((album) => manualAlbumOpen(access, album))
  if (photo.libraryMount) {
    const folderOk = scanOpen(access, photo.libraryMount, photo.libraryPath || null)
    if (folderOk) return true
    return manualOk
  }
  if (albums.length === 0) return true
  return manualOk
}
