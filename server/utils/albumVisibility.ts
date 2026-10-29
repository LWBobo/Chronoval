/**
 * 普通相簿可见范围，和人物相册同一套三档。
 * 旧的 isHidden 只表示「未登录不可见」，迁移时对应 login，不是仅管理员。
 */
export type AlbumVisibility = 'public' | 'login' | 'admin'

export function normalizeAlbumVisibility(album: {
  visibility?: string | null
  isHidden?: boolean | null
}): AlbumVisibility {
  if (
    album.visibility === 'public' ||
    album.visibility === 'login' ||
    album.visibility === 'admin'
  ) {
    return album.visibility
  }
  return album.isHidden ? 'login' : 'public'
}

export function albumOpenToActor(
  album: { visibility?: string | null; isHidden?: boolean | null },
  actor: { user?: { id?: string | number } | null; isAdmin?: boolean },
) {
  const visibility = normalizeAlbumVisibility(album)
  if (visibility === 'public') return true
  if (visibility === 'login') return Boolean(actor.user)
  return Boolean(actor.isAdmin)
}

/** Kept as a no-op for callers shared with older clients. Grants own visibility. */
export function ensureAlbumVisibilityColumn() {}
