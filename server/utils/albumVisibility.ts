import { collectionAudienceAccess } from '../services/collections/access'
/**
 * 普通相簿可见范围，和人物相册同一套三档。
 * 旧的 isHidden 只表示「未登录不可见」，迁移时对应 login，不是仅管理员。
 */
export type AlbumVisibility = 'public' | 'login' | 'selected' | 'admin'

export function normalizeAlbumVisibility(album: {
  visibility?: string | null
  isHidden?: boolean | null
}): AlbumVisibility {
  if (
    album.visibility === 'public' ||
    album.visibility === 'login' ||
    album.visibility === 'admin' || album.visibility === 'selected'
  ) {
    return album.visibility
  }
  return 'admin'
}

export function albumOpenToActor(
  album: { id?: number; collectionId?: number; visibility?: string | null; isHidden?: boolean | null; viewerIds?: number[] },
  actor: { user?: { id?: string | number } | null; isAdmin?: boolean },
) {
  const id = album.collectionId ?? album.id
  if (id) return collectionAudienceAccess(id, { user: actor.user ? { id: Number(actor.user.id) } as any : null, isAdmin: !!actor.isAdmin })
  const visibility = normalizeAlbumVisibility(album)
  if (visibility === 'public') return true
  if (actor.isAdmin) return true
  if (visibility === 'login') return Boolean(actor.user)
  return visibility === 'selected' && !!actor.user && !!album.viewerIds?.includes(Number(actor.user.id))
}

export function ensureAlbumVisibilityColumn() {}
