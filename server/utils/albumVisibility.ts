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
  actor: { user?: { id?: string } | null; isAdmin?: boolean },
) {
  const visibility = normalizeAlbumVisibility(album)
  if (visibility === 'public') return true
  if (visibility === 'login') return Boolean(actor.user)
  return Boolean(actor.isAdmin)
}

let visibilityColumnReady = false

/** 迁移被跳过时补上 visibility。旧的隐藏相簿仍是「仅登录」，不会被抬成仅管理员。 */
export function ensureAlbumVisibilityColumn() {
  if (visibilityColumnReady) return
  const sqlite = useSqlite()
  const table = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'albums'`,
    )
    .get()
  if (!table) return
  const cols = sqlite.prepare(`PRAGMA table_info(albums)`).all() as {
    name: string
  }[]
  if (!cols.some((col) => col.name === 'visibility')) {
    sqlite.exec(
      `ALTER TABLE albums ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
    )
    sqlite.exec(`UPDATE albums SET visibility = 'login' WHERE is_hidden = 1`)
  }
  visibilityColumnReady = true
}
