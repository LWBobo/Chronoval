import { getTableColumns, sql } from 'drizzle-orm'
import { photos } from '../database/schema'

/** Project media URLs from the file registry; these are never persisted on photos. */
export function photoAssetSql(role: 'original' | 'download' | 'thumbnail' | 'live_video') {
  const roles = role === 'original'
    ? sql`CASE WHEN ${photos.stripLocation}=1 THEN 'sanitized_download' WHEN ${photos.type}='video' THEN 'original' ELSE 'preview' END,CASE WHEN ${photos.stripLocation}=0 THEN 'original' WHEN ${photos.type}='image' THEN 'preview' ELSE 'sanitized_download' END`
    : role === 'download' ? sql`CASE WHEN ${photos.stripLocation}=1 THEN 'sanitized_download' ELSE 'original' END`
    : role === 'thumbnail' ? sql`'thumbnail','poster','preview'` : sql`'live_video'`
  const priority = role === 'thumbnail'
    ? sql`CASE pf.role WHEN 'thumbnail' THEN 0 WHEN 'poster' THEN 1 ELSE 2 END`
    : sql`CASE pf.role WHEN 'sanitized_download' THEN 0 WHEN 'preview' THEN 1 ELSE 2 END`
  // Drizzle removes column qualifiers in a single-table SELECT projection.
  // Keep this correlation explicit so "id" cannot resolve to photo_files.id.
  return sql<string | null>`(SELECT '/api/assets/'||pf.id FROM photo_files pf WHERE pf.photo_id="photos"."id" AND pf.state='ready' AND pf.role IN (${roles}) ORDER BY ${priority} LIMIT 1)`
}

export function photoWithMediaColumns() {
  return { ...getTableColumns(photos), originalUrl: photoAssetSql('original'), downloadUrl: photoAssetSql('download'), thumbnailUrl: photoAssetSql('thumbnail'), livePhotoVideoUrl: photoAssetSql('live_video') }
}
