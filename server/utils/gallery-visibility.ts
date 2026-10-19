import { sql, type SQL } from 'drizzle-orm'
import {
  photoAllowedByPeopleSql,
  type PersonViewer,
} from '~~/server/services/ml/person.service'
import { ensureAlbumVisibilityColumn } from '~~/server/utils/albumVisibility'

/**
 * 首页瀑布流可见性，随当前是否登录变化：
 * - 仅「登录可见」（相簿 visibility=login、且没有访问密码）：未登录不显示，登录后显示。
 * - 「仅管理员」（visibility=admin）：普通登录用户和访客的首页都不显示。
 * - 「输入密码可见」：瀑布流始终不显示，只能进入相簿后查看。
 * - 「首页照片画廊隐藏」：始终不显示。
 * - 照片中任意一个人当前访问者不可见时，整张照片不显示。
 *   其中一个人改回公开后，只要还有人是登录可见或仅管理员，照片继续隐藏。
 *
 * 扫描子相簿沿目录取最长的 scan_album_meta 作为隐藏状态；
 * 自身或任一上级设了密码，则该目录下的照片不进瀑布流。
 */
export const homepageGalleryVisibilitySql = (
  loggedIn: boolean,
  peopleViewer?: PersonViewer,
): SQL => {
  ensureAlbumVisibilityColumn()
  const loggedInSql = loggedIn ? sql`1` : sql`0`
  const viewer = peopleViewer ?? (loggedIn ? 'user' : 'public')
  const adminViewer = viewer === 'admin' ? sql`1` : sql`0`

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
         OR (
           ${tables.albums.visibility} = 'admin'
           AND ${adminViewer} = 0
         )
         OR (
           (
             ${tables.albums.visibility} = 'login'
             OR (
               (${tables.albums.visibility} IS NULL OR ${tables.albums.visibility} = '')
               AND ${tables.albums.isHidden} = 1
             )
           )
           AND ${loggedInSql} = 0
         )
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
    AND ${photoAllowedByPeopleSql(viewer)}
  )`
}
