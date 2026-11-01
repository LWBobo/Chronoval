import { photoWithMediaColumns } from './photo-media'
import type { H3Event } from 'h3'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { photoVisibleSql } from './photo-visibility'
import { getActor, type Actor } from './access'
import { collectionPasswordAccess } from './collection-password'
import { isAlbumAdminBypass } from './albumAccess'

const PHOTO_ID_BATCH_SIZE = 500

/**
 * 找出当前会话已经解锁的集合。集合数量通常远小于照片数量，这部分只在一次
 * 批量可见性查询前计算一次，并作为 SQL 的密码豁免集合传入。
 */
export function unlockedCollectionIds(event: H3Event): number[] {
  return useDB().select({ id: tables.collections.id }).from(tables.collections).all().filter((row) => collectionPasswordAccess(event,row.id)).map((row) => row.id)
}

export interface PhotoAccessContext {
  actor: Actor
  viewerRank: 0 | 1 | 2
  userId: number | null
  unlockedIds: number[]
  adminPasswordBypass: boolean
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
    adminPasswordBypass: await isAlbumAdminBypass(event, actor),
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
    adminPasswordBypass: context.adminPasswordBypass,
  })
}

export async function requireVisiblePhoto(
  event: H3Event,
  photoId: string,
  options: {
    context?: PhotoAccessContext
    allowAdminDeleted?: boolean
    allowOwnerDeleted?: boolean
  } = {},
) {
  const context = options.context ?? (await buildPhotoAccessContext(event))
  const db = useDB()

  let photo =
    options.allowAdminDeleted && context.actor.isAdmin
      ? db.select(photoWithMediaColumns()).from(tables.photos).where(eq(tables.photos.id, photoId)).get()
      : db
          .select(photoWithMediaColumns())
          .from(tables.photos)
          .where(
            and(eq(tables.photos.id, photoId), visiblePhotoSql(context)),
          )
          .get()

  if (!photo && options.allowOwnerDeleted && context.userId) {
    photo = db.select(photoWithMediaColumns()).from(tables.photos).where(and(eq(tables.photos.id, photoId), eq(tables.photos.ownershipType, 'user'), eq(tables.photos.ownerId, context.userId))).get()
  }
  if (photo && (photo.processingStatus === 'purging' || photo.processingStatus === 'uploading' || (photo.transferState === 'moving' && !context.actor.isAdmin))) photo = undefined

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
