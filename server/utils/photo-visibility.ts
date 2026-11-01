import { sql, type SQL } from 'drizzle-orm'
import { collectionAudienceSql } from '../services/collections/access'

export type PhotoSurface = 'gallery' | 'discover'
export type PhotoVisibilityOptions = { viewerRank: 0 | 1 | 2; userId: number | null; surface: PhotoSurface; unlockedIds: number[]; adminPasswordBypass?: boolean }
export function photoVisibilityClauses(options: PhotoVisibilityOptions) {
  const userId = options.userId ?? -1
  const admin = options.viewerRank === 2
  // NOT IN (NULL) is UNKNOWN in SQLite and silently removes password blockers.
  // A non-existent positive collection ID keeps both IN and NOT IN boolean.
  const unlocked = options.unlockedIds.length ? sql.join(options.unlockedIds.map((id) => sql`${id}`), sql`,`) : sql`-1`
  const onPath = sql`(c.rel_path='' OR (${tables.photos.libraryPath} IS NOT NULL AND substr(${tables.photos.libraryPath},1,length(c.rel_path)+1)=c.rel_path||'/'))`
  const relevant = sql`c.ownership_type='site' AND (
    (c.kind='manual' AND EXISTS(SELECT 1 FROM collection_photos cp WHERE cp.collection_id=c.id AND cp.photo_id=${tables.photos.id})) OR
    (c.kind='folder' AND c.library_id=${tables.photos.libraryId} AND ${onPath}) OR
    (c.kind='person' AND EXISTS(SELECT 1 FROM asset_faces af INNER JOIN people p ON p.id=af.person_id WHERE af.photo_id=${tables.photos.id} AND p.collection_id=c.id AND p.ownership_type='site'))
  )`
  const audience = sql`NOT EXISTS(SELECT 1 FROM collections c WHERE ${relevant} AND NOT ${collectionAudienceSql(sql`c.id`, options.userId, admin)})`
  const exempt = sql`(${userId}>0 AND (c.password_exempt_mode='logged_in' OR (c.password_exempt_mode='selected' AND EXISTS(SELECT 1 FROM collection_password_exemptions ce WHERE ce.collection_id=c.id AND ce.user_id=${userId}))))`
  const inheritedUnlock = sql`EXISTS(SELECT 1 FROM collections uf WHERE uf.id IN (${unlocked}) AND uf.kind='folder' AND uf.library_id=c.library_id AND length(uf.rel_path)>=length(c.rel_path) AND (uf.rel_path='' OR substr(${tables.photos.libraryPath},1,length(uf.rel_path)+1)=uf.rel_path||'/'))`
  const effectivePassword = sql`c.password_hash IS NOT NULL AND c.password_hash!='' AND (c.kind!='folder' OR NOT EXISTS(SELECT 1 FROM collections deeper WHERE deeper.kind='folder' AND deeper.library_id=c.library_id AND deeper.password_hash IS NOT NULL AND deeper.password_hash!='' AND length(deeper.rel_path)>length(c.rel_path) AND substr(${tables.photos.libraryPath},1,length(deeper.rel_path)+1)=deeper.rel_path||'/'))`
  const passwordOk = sql`NOT EXISTS(SELECT 1 FROM collections c WHERE ${relevant} AND ${effectivePassword} AND NOT ${exempt} ${options.surface === 'discover' ? sql`AND c.id NOT IN (${unlocked}) AND NOT (c.kind='folder' AND ${inheritedUnlock})` : sql``})`
  const displayOk = options.surface === 'gallery' ? sql`NOT EXISTS(SELECT 1 FROM collections c WHERE ${relevant} AND c.kind IN ('manual','folder') AND c.show_on_gallery=0)` : sql`1`
  const owner = sql`(${userId}>0 AND ${tables.photos.ownershipType}='user' AND ${tables.photos.ownerId}=${userId})`
  const ready = sql`${tables.photos.processingStatus}='ready' AND ${tables.photos.deletedAt} IS NULL AND ${tables.photos.moderationStatus}='visible'`
  const personal = sql`(${tables.photos.ownershipType}='site' OR (${tables.photos.ownershipType}='user' AND EXISTS(SELECT 1 FROM users u WHERE u.id=${tables.photos.ownerId} AND u.status='active') AND (${tables.photos.visibility}='public' OR (${tables.photos.visibility}='shared' AND EXISTS(SELECT 1 FROM photo_shares ps WHERE ps.photo_id=${tables.photos.id} AND ps.recipient_user_id=${userId})))))`
  const library = sql`(${tables.photos.libraryId} IS NULL OR EXISTS(SELECT 1 FROM libraries lib WHERE lib.id=${tables.photos.libraryId} AND lib.enabled=1))`
  const lifecycle = sql`${tables.photos.transferState}!='moving' AND ${tables.photos.processingStatus}!='purging' AND ${tables.photos.deletedAt} IS NULL AND ${library}`
  return { lifecycle, owner: options.surface === 'discover' ? owner : sql`0`, photoAcl: sql`${ready} AND ${personal}`, audience, displayOk, passwordOk: admin && options.adminPasswordBypass && options.surface === 'discover' ? sql`1` : passwordOk, relevant }
}

export function photoVisibleSql(options: PhotoVisibilityOptions): SQL {
  const p = photoVisibilityClauses(options)
  return sql`${p.lifecycle} AND (${p.owner} OR (${p.photoAcl} AND ${p.audience} AND ${p.displayOk} AND ${p.passwordOk}))`
}
