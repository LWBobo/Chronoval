import { folderAudienceAccess } from '../services/collections/access'
import type { H3Event } from 'h3'
import { and, inArray } from 'drizzle-orm'
import type { Actor } from './access'
import { albumOpenToActor } from './albumVisibility'
import { isPasswordExemptForUser } from './albumPasswordExempt'
import { hasInheritedScanAlbumAccess } from './scanAlbumAuth'
import { buildPhotoAccessContext, visiblePhotoSql } from './photo-access'
import {
  getScanAlbumEffectiveAuth,
  getScanAlbumEffectiveVisibility,
} from '../services/scan-library/manager'

/** 列表、详情和嵌套节点共用权限与脱敏规则；封面和计数只引用可读取的照片。 */
export async function serializeScanAlbumNodes(
  event: H3Event,
  nodes: any[],
  options: {
    actor: Actor
    manageMode?: boolean
    adminBypass?: boolean
    resolveBgm: (id?: number | null) => any
  },
): Promise<any[]> {
  if (!nodes.length) return []
  const manageMode = options.manageMode === true && options.actor.isAdmin
  const context = await buildPhotoAccessContext(event)
  const libraryIds = [...new Set(nodes.map((node) => Number(node.libId)))]
  const photos = useDB()
    .select({
      id: tables.photos.id,
      libraryId: tables.photos.libraryId,
      libraryPath: tables.photos.libraryPath,
      type: tables.photos.type,
    })
    .from(tables.photos)
    .where(
      and(
        inArray(tables.photos.libraryId, libraryIds),
        manageMode ? undefined : visiblePhotoSql(context),
      ),
    )
    .all()
  const visibleIds = new Set(photos.map((photo) => photo.id))
  const counts = new Map<string, { photoCount: number; videoCount: number }>()
  for (const photo of photos) {
    const path = photo.libraryPath || ''
    const slash = path.lastIndexOf('/')
    const folder = slash < 0 ? '' : path.slice(0, slash)
    const key = `${photo.libraryId}:${folder}`
    const count = counts.get(key) || { photoCount: 0, videoCount: 0 }
    if (photo.type === 'video') count.videoCount++
    else count.photoCount++
    counts.set(key, count)
  }

  const visit = async (node: any): Promise<any | null> => {
    const visibility = getScanAlbumEffectiveVisibility(node.libId, node.relPath)
    if (!folderAudienceAccess(node.libId, node.relPath, options.actor)) return null
    const auth = await getScanAlbumEffectiveAuth(node.libId, node.relPath)
    const sessionExempt = isPasswordExemptForUser(
      {
        passwordHash: auth.passwordHash,
        passwordExemptMode: auth.exemptMode,
        passwordExemptUsers: auth.exemptUsers,
      },
      options.actor.user,
    )
    const authorized =
      manageMode ||
      hasInheritedScanAlbumAccess(
        event,
        {
          libId: node.libId,
          relPath: node.relPath,
          passwordHash: auth.passwordHash,
          passwordPath: auth.passwordPath,
          sessionExempt,
        },
        options.adminBypass === true,
      )
    const {
      password: _password,
      passwordHash: _passwordHash,
      passwordExemptMode,
      passwordExemptUsers,
      children: rawChildren,
      ...rest
    } = node
    const safe = {
      ...rest,
      visibility,
      passwordProtected: Boolean(auth.passwordHash),
      authorized,
      ...(manageMode ? { passwordExemptMode, passwordExemptUsers } : {}),
    }
    if (!authorized)
      return {
        ...safe,
        covers: [],
        coverPhotoId: null,
        photoCount: 0,
        videoCount: 0,
        bgmMusicId: null,
        bgm: null,
        children: [],
        hasChildren: false,
      }
    const covers = (node.covers || []).filter((cover: { id: string }) =>
      visibleIds.has(cover.id),
    )
    const children: any[] = []
    for (const child of rawChildren || []) {
      const visibleChild = await visit(child)
      if (visibleChild) children.push(visibleChild)
    }
    return {
      ...safe,
      ...(counts.get(`${node.libId}:${node.relPath}`) || {
        photoCount: 0,
        videoCount: 0,
      }),
      covers,
      coverPhotoId: visibleIds.has(node.coverPhotoId)
        ? node.coverPhotoId
        : (covers[0]?.id ?? null),
      bgm: options.resolveBgm(node.bgmMusicId),
      ...(Array.isArray(rawChildren)
        ? { children, hasChildren: children.length > 0 }
        : {}),
    }
  }
  const result: any[] = []
  for (const node of nodes) {
    const visibleNode = await visit(node)
    if (visibleNode) result.push(visibleNode)
  }
  return result
}
