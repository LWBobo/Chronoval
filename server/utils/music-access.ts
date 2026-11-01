import { folderAudienceAccess } from '../services/collections/access'
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { getActor } from './access'
import { albumOpenToActor } from './albumVisibility'
import { hasAlbumAccess } from './manualAlbumAuth'
import { hasInheritedScanAlbumAccess } from './scanAlbumAuth'
import { isPasswordExemptForUser } from './albumPasswordExempt'
import { readCollectionAccess } from '../services/collections/access-grants'
import { getManualAlbumById } from '../services/collections/manual-album'
import {
  getScanAlbumEffectiveAuth,
  getScanAlbumEffectiveVisibility,
} from '../services/scan-library/manager'

export async function requireMusicAccess(event: H3Event, musicId: number) {
  const db = useDB()
  const music = db
    .select()
    .from(tables.music)
    .where(eq(tables.music.id, musicId))
    .get()
  if (!music) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const actor = await getActor(event)
  if (actor.isAdmin) return music

  const collections = db
    .select()
    .from(tables.collections)
    .where(eq(tables.collections.bgmMusicId, musicId))
    .all()

  for (const collection of collections) {
    const access = readCollectionAccess(collection.id, db)
    if (!albumOpenToActor(access, actor)) continue

    if (collection.kind === 'manual') {
      const album = getManualAlbumById(collection.id)
      if (!album) continue
      const exempt = isPasswordExemptForUser(album, actor.user)
      if (
        !album.passwordHash ||
        exempt ||
        hasAlbumAccess(
          event,
          {
            albumId: album.id,
            passwordHash: album.passwordHash,
            sessionExempt: exempt,
          },
          false,
        )
      ) {
        return music
      }
      continue
    }

    if (collection.kind === 'folder' && collection.libraryId != null) {
      const visibility = getScanAlbumEffectiveVisibility(
        collection.libraryId,
        collection.relPath,
      )
      if (!folderAudienceAccess(collection.libraryId, collection.relPath, actor)) continue
      const auth = await getScanAlbumEffectiveAuth(
        collection.libraryId,
        collection.relPath,
      )
      const exempt = isPasswordExemptForUser(
        {
          passwordHash: auth.passwordHash,
          passwordExemptMode: auth.exemptMode,
          passwordExemptUsers: auth.exemptUsers,
        },
        actor.user,
      )
      if (
        !auth.passwordHash ||
        exempt ||
        hasInheritedScanAlbumAccess(
          event,
          {
            libId: collection.libraryId,
            relPath: collection.relPath,
            passwordHash: auth.passwordHash,
            passwordPath: auth.passwordPath,
          },
          false,
        )
      ) {
        return music
      }
    }
  }

  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
}
