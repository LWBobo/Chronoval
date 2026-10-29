import { sql, type SQL } from 'drizzle-orm'

export type PhotoSurface = 'gallery' | 'discover'

/**
 * 照片可见性只看集合授权。
 * 档位 public < login < admin。多本相簿、人物相册取最严的一档。
 * audience=user 只表示密码免密，不抬高档位。user_id 为空表示全体登录用户免密。
 */
export function photoVisibleSql(options: {
  viewerRank: 0 | 1 | 2
  userId: number | null
  surface: PhotoSurface
  unlockedIds: number[]
}): SQL {
  const viewerRank = options.viewerRank
  const userId = options.userId ?? -1
  const unlocked = options.unlockedIds.length
    ? sql.join(
        options.unlockedIds.map((id) => sql`${id}`),
        sql`, `,
      )
    : sql`NULL`

  const rankOf = (idExpr: SQL) => sql`COALESCE((
    SELECT MAX(CASE ${tables.accessGrants.audience}
      WHEN 'admin' THEN 2
      WHEN 'login' THEN 1
      WHEN 'public' THEN 0
      ELSE NULL END)
    FROM ${tables.accessGrants}
    WHERE ${tables.accessGrants.collectionId} = ${idExpr}
      AND ${tables.accessGrants.audience} IN ('public', 'login', 'admin')
  ), 0)`

  const photoRank = sql`COALESCE((
    SELECT MAX(scope.rank) FROM (
      SELECT ${rankOf(sql`c.id`)} AS rank
      FROM ${tables.collectionPhotos} cp
      INNER JOIN ${tables.collections} c ON c.id = cp.collection_id AND c.kind = 'manual'
      WHERE cp.photo_id = ${tables.photos.id}
      UNION ALL
      SELECT ${rankOf(sql`folder.id`)} AS rank
      FROM ${tables.collections} folder
      WHERE folder.kind = 'folder'
        AND folder.library_id = ${tables.photos.libraryId}
        AND (
          folder.rel_path = ''
          OR (
            ${tables.photos.libraryPath} IS NOT NULL
            AND substr(${tables.photos.libraryPath}, 1, length(folder.rel_path) + 1) = folder.rel_path || '/'
          )
        )
      UNION ALL
      SELECT ${rankOf(sql`person.collection_id`)} AS rank
      FROM ${tables.assetFaces} face
      INNER JOIN ${tables.people} person ON person.id = face.person_id
      WHERE face.photo_id = ${tables.photos.id}
        AND person.collection_id IS NOT NULL
    ) scope
  ), 0)`

  const exempt = (idExpr: SQL) => sql`(
    (${viewerRank} >= 1 AND EXISTS (
      SELECT 1 FROM ${tables.accessGrants} g
      WHERE g.collection_id = ${idExpr}
        AND g.audience = 'user'
        AND g.user_id IS NULL
    ))
    OR EXISTS (
      SELECT 1 FROM ${tables.accessGrants} g
      WHERE g.collection_id = ${idExpr}
        AND g.audience = 'user'
        AND g.user_id = ${userId}
    )
  )`

  const onPath = sql`(
    c.rel_path = ''
    OR (
      ${tables.photos.libraryPath} IS NOT NULL
      AND substr(${tables.photos.libraryPath}, 1, length(c.rel_path) + 1) = c.rel_path || '/'
    )
  )`

  const manualPasswordBlocked = (honorUnlock: boolean) => sql`EXISTS (
    SELECT 1 FROM ${tables.collections} c
    INNER JOIN ${tables.collectionPhotos} cp
      ON cp.collection_id = c.id
    WHERE c.password_hash IS NOT NULL
      AND c.password_hash != ''
      AND c.kind = 'manual'
      AND cp.photo_id = ${tables.photos.id}
      AND NOT ${exempt(sql`c.id`)}
      ${
        honorUnlock && options.unlockedIds.length
          ? sql`AND c.id NOT IN (${unlocked})`
          : sql``
      }
  )`

  // 扫描密码沿目录向下继承，但独立密码形成新边界。解锁范围必须位于
  // 当前生效密码的来源目录之下，且是照片的祖先；不能越过密码边界或授权兄弟目录。
  const effectiveFolderPasswordId = sql`(
    SELECT c.id FROM ${tables.collections} c
    WHERE c.kind = 'folder'
      AND c.library_id = ${tables.photos.libraryId}
      AND c.password_hash IS NOT NULL
      AND c.password_hash != ''
      AND ${onPath}
    ORDER BY length(c.rel_path) DESC
    LIMIT 1
  )`
  const folderPasswordBlocked = (honorUnlock: boolean) => sql`(
    (${effectiveFolderPasswordId}) IS NOT NULL
    AND NOT ${exempt(effectiveFolderPasswordId)}
    ${
      honorUnlock && options.unlockedIds.length
        ? sql`AND NOT EXISTS (
            SELECT 1 FROM ${tables.collections} unlocked_folder
            WHERE unlocked_folder.id IN (${unlocked})
              AND unlocked_folder.kind = 'folder'
              AND unlocked_folder.library_id = ${tables.photos.libraryId}
              AND length(unlocked_folder.rel_path) >= COALESCE((
                SELECT length(password_origin.rel_path)
                FROM ${tables.collections} password_origin
                WHERE password_origin.id = (${effectiveFolderPasswordId})
              ), 0)
              AND (
                unlocked_folder.rel_path = ''
                OR (
                  ${tables.photos.libraryPath} IS NOT NULL
                  AND substr(${tables.photos.libraryPath}, 1, length(unlocked_folder.rel_path) + 1) = unlocked_folder.rel_path || '/'
                )
              )
          )`
        : sql``
    }
  )`

  const galleryHidden = sql`(
    EXISTS (
      SELECT 1
      FROM ${tables.collectionPhotos} cp
      INNER JOIN ${tables.collections} c ON c.id = cp.collection_id AND c.kind = 'manual'
      WHERE cp.photo_id = ${tables.photos.id}
        AND c.show_on_gallery = 0
    )
    OR EXISTS (
      SELECT 1 FROM ${tables.collections} folder
      WHERE folder.kind = 'folder'
        AND folder.library_id = ${tables.photos.libraryId}
        AND folder.show_on_gallery = 0
        AND (
          folder.rel_path = ''
          OR (
            ${tables.photos.libraryPath} IS NOT NULL
            AND substr(${tables.photos.libraryPath}, 1, length(folder.rel_path) + 1) = folder.rel_path || '/'
          )
        )
    )
  )`

  const galleryPassword = sql`(
    ${manualPasswordBlocked(false)} OR ${folderPasswordBlocked(false)}
  )`
  const discoverPassword = sql`(
    ${manualPasswordBlocked(true)} OR ${folderPasswordBlocked(true)}
  )`

  const rankOk = sql`(
    ${viewerRank} >= 2
    OR ${viewerRank} >= (${photoRank})
  )`

  return sql`(
    ${tables.photos.deletedAt} IS NULL
    AND (
      ${tables.photos.libraryId} IS NULL
      OR EXISTS (
        SELECT 1 FROM ${tables.libraries} lib
        WHERE lib.id = ${tables.photos.libraryId} AND lib.enabled = 1
      )
    )
    AND ${
      options.surface === 'gallery'
        ? sql`${rankOk} AND NOT ${galleryHidden} AND NOT ${galleryPassword}`
        : sql`(${viewerRank} >= 2 OR (${rankOk} AND NOT ${discoverPassword}))`
    }
  )`
}
