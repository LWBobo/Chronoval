import type { H3Event } from 'h3'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { photoVisibleSql } from './photo-visibility'
import { getActor, type Actor } from './access'
import { hasAlbumAccess } from './manualAlbumAuth'
import { hasScanAlbumAccess } from './scanAlbumAuth'

const PHOTO_ID_BATCH_SIZE = 500

/**
 * 找出当前会话已经解锁的集合。集合数量通常远小于照片数量，这部分只在一次
 * 批量可见性查询前计算一次，并作为 SQL 的密码豁免集合传入。
 */
export function unlockedCollectionIds(event: H3Event): number[] {
  const rows = useDB()
    .select({
      id: tables.collections.id,
      kind: tables.collections.kind,
      libraryId: tables.collections.libraryId,
      relPath: tables.collections.relPath,
      passwordHash: tables.collections.passwordHash,
    })
    .from(tables.collections)
    .all()

  const unlocked: number[] = []
  for (const row of rows) {
    if (row.kind === 'manual') {
      if (!row.passwordHash) continue
      if (
        hasAlbumAccess(
          event,
          {
            albumId: row.id,
            passwordHash: row.passwordHash,
            sessionExempt: false,
          },
          false,
        )
      ) {
        unlocked.push(row.id)
      }
      continue
    }

    if (row.kind !== 'folder' || row.libraryId == null) continue
    // 子目录可继承最近父目录的密码。解锁子目录时 Cookie 作用域仍是子目录路径，
    // 因此即使该集合自身 passwordHash 为空，也必须用继承后的哈希检查它的 Cookie。
    const effectivePassword = rows
      .filter(
        (candidate) =>
          candidate.kind === 'folder' &&
          candidate.libraryId === row.libraryId &&
          candidate.passwordHash &&
          (candidate.relPath === '' ||
            row.relPath === candidate.relPath ||
            row.relPath.startsWith(`${candidate.relPath}/`)),
      )
      .sort((a, b) => b.relPath.length - a.relPath.length)[0]?.passwordHash
    if (!effectivePassword) continue
    if (
      hasScanAlbumAccess(
        event,
        {
          libId: row.libraryId,
          relPath: row.relPath,
          passwordHash: effectivePassword,
          sessionExempt: false,
        },
        false,
      )
    ) {
      unlocked.push(row.id)
    }
  }
  return unlocked
}

export interface PhotoAccessContext {
  actor: Actor
  viewerRank: 0 | 1 | 2
  userId: number | null
  unlockedIds: number[]
}

export async function buildPhotoAccessContext(
  event: H3Event,
): Promise<PhotoAccessContext> {
  const actor = await getActor(event)
  const viewerRank = actor.isAdmin ? 2 : actor.user ? 1 : 0
  const rawUserId = actor.user?.id == null ? null : Number(actor.user.id)
  return {
    actor,
    viewerRank,
    userId: Number.isFinite(rawUserId) ? rawUserId : null,
    unlockedIds: unlockedCollectionIds(event),
  }
}

export function visiblePhotoSql(
  context: PhotoAccessContext,
  surface: 'gallery' | 'discover' = 'discover',
): SQL {
  return photoVisibleSql({
    viewerRank: context.viewerRank,
    userId: context.userId,
    surface,
    unlockedIds: context.unlockedIds,
  })
}

export async function requireVisiblePhoto(
  event: H3Event,
  photoId: string,
  options: {
    context?: PhotoAccessContext
    allowAdminDeleted?: boolean
  } = {},
) {
  const context = options.context ?? (await buildPhotoAccessContext(event))
  const db = useDB()

  const photo =
    options.allowAdminDeleted && context.actor.isAdmin
      ? db.select().from(tables.photos).where(eq(tables.photos.id, photoId)).get()
      : db
          .select()
          .from(tables.photos)
          .where(
            and(eq(tables.photos.id, photoId), visiblePhotoSql(context)),
          )
          .get()

  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  return { photo, context }
}

/**
 * 批量计算“发现”入口可见的照片 id。
 *
 * 旧实现先加载全部旧相簿关系，再对每张照片单独执行一次 photoVisibleSql，人物页
 * 和智能搜索会形成 N+1 查询。这里把候选 id 分成 SQLite 友好的批次，每批只执行
 * 一条带统一可见性条件的 SQL；即使候选达到数万张，也只产生少量查询。
 */
export async function discoverablePhotoIds(
  event: H3Event,
  photoIds: Iterable<string>,
): Promise<Set<string>> {
  const uniqueIds = [...new Set(photoIds)].filter(Boolean)
  if (uniqueIds.length === 0) return new Set()

  const context = await buildPhotoAccessContext(event)
  const visible = new Set<string>()
  const db = useDB()

  for (let start = 0; start < uniqueIds.length; start += PHOTO_ID_BATCH_SIZE) {
    const batch = uniqueIds.slice(start, start + PHOTO_ID_BATCH_SIZE)
    const rows = db
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(
        and(
          inArray(tables.photos.id, batch),
          visiblePhotoSql(context),
        ),
      )
      .all()

    for (const row of rows) visible.add(row.id)
  }

  return visible
}
