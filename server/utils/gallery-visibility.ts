import { sql, type SQL } from 'drizzle-orm'

/**
 * 首页瀑布流可见性，随当前是否登录变化：
 * - 仅「登录可见」（相簿隐藏、且没有访问密码）：未登录不显示，登录后显示。
 * - 「输入密码可见」：瀑布流始终不显示，只能进入相簿后查看。
 * - 「首页照片画廊隐藏」：始终不显示。
 *
 * 扫描子相簿沿目录取最长的 scan_album_meta 作为隐藏状态；
 * 自身或任一上级设了密码，则该目录下的照片不进瀑布流。
 */
export const homepageGalleryVisibilitySql = (loggedIn: boolean): SQL => {
  const loggedInSql = loggedIn ? sql`1` : sql`0`

  // 照片所在目录是否落在某条扫描相簿元数据下（前缀匹配，避开 LIKE 通配符）
  const inFolder = sql`(
    ${tables.scanAlbumMeta.relPath} = ''
    OR (
      ${tables.scanAlbumMeta.relPath} != ''
      AND ${tables.photos.libraryPath} IS NOT NULL
      AND substr(
        ${tables.photos.libraryPath},
        1,
        length(${tables.scanAlbumMeta.relPath}) + 1
      ) = ${tables.scanAlbumMeta.relPath} || '/'
    )
  )`

  return sql`(
    ${tables.photos.id} NOT IN (
      SELECT ${tables.albumPhotos.photoId}
      FROM ${tables.albumPhotos}
      INNER JOIN ${tables.albums}
        ON ${tables.albumPhotos.albumId} = ${tables.albums.id}
      WHERE ${tables.albums.hideFromGallery} = 1
         OR (
           ${tables.albums.passwordHash} IS NOT NULL
           AND ${tables.albums.passwordHash} != ''
         )
         OR (${tables.albums.isHidden} = 1 AND ${loggedInSql} = 0)
    )
    AND (
      ${tables.photos.libraryMount} IS NULL
      OR (
        NOT EXISTS (
          SELECT 1
          FROM ${tables.scanAlbumMeta}
          WHERE ${tables.scanAlbumMeta.mount} = ${tables.photos.libraryMount}
            AND ${tables.scanAlbumMeta.passwordHash} IS NOT NULL
            AND ${tables.scanAlbumMeta.passwordHash} != ''
            AND ${inFolder}
        )
        AND (
          ${loggedInSql} = 1
          OR COALESCE((
            SELECT ${tables.scanAlbumMeta.isHidden}
            FROM ${tables.scanAlbumMeta}
            WHERE ${tables.scanAlbumMeta.mount} = ${tables.photos.libraryMount}
              AND ${inFolder}
            ORDER BY length(${tables.scanAlbumMeta.relPath}) DESC
            LIMIT 1
          ), 0) = 0
        )
      )
    )
  )`
}
