import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm'

function likeTerm(raw: string) {
  return `%${raw.replace(/[%_]/g, '')}%`
}

/** 管理端候选照片。不套用首页展示开关，回收站和已禁用的库除外。 */
export default eventHandler(async (event) => {
  const query = getQuery(event)
  const collectionId = Number(query.collectionId)
  if (!Number.isFinite(collectionId)) {
    throw createError({ statusCode: 400, message: 'collectionId required' })
  }
  const db = useDB()
  const collection = db
    .select()
    .from(tables.collections)
    .where(eq(tables.collections.id, collectionId))
    .get()
  if (!collection) throw createError({ statusCode: 404, message: 'Collection not found' })
  if (collection.kind === 'folder') {
    throw createError({ statusCode: 400, message: 'Folder membership comes from the scan path' })
  }

  const limit = Math.min(80, Math.max(1, Number(query.limit) || 48))
  const q = String(query.q || '').trim()
  const cursor = String(query.cursor || '')
  const [cursorDate, cursorId] = cursor.split('|')
  const term = q ? likeTerm(q) : ''

  const filters = [
    isNull(tables.photos.deletedAt),
    or(
      isNull(tables.photos.libraryId),
      sql`EXISTS (
        SELECT 1 FROM ${tables.libraries}
        WHERE ${tables.libraries.id} = ${tables.photos.libraryId}
          AND ${tables.libraries.enabled} = 1
      )`,
    ),
  ]
  if (term) {
    filters.push(
      or(
        like(tables.photos.title, term),
        like(tables.photos.id, term),
        like(tables.photos.libraryPath, term),
        like(tables.photos.city, term),
        like(tables.photos.locationName, term),
      )!,
    )
  }
  if (cursorId) {
    filters.push(sql`(
      COALESCE(${tables.photos.dateTaken}, '') < ${cursorDate || ''}
      OR (
        COALESCE(${tables.photos.dateTaken}, '') = ${cursorDate || ''}
        AND ${tables.photos.id} < ${cursorId}
      )
    )`)
  }

  const rows = db
    .select({
      id: tables.photos.id,
      title: tables.photos.title,
      thumbnailUrl: tables.photos.thumbnailUrl,
      dateTaken: tables.photos.dateTaken,
    })
    .from(tables.photos)
    .where(and(...filters))
    .orderBy(
      sql`COALESCE(${tables.photos.dateTaken}, '') DESC`,
      desc(tables.photos.id),
    )
    .limit(limit + 1)
    .all()

  const page = rows.slice(0, limit)
  const memberIds = new Set<string>()
  if (page.length && collection.kind === 'manual') {
    const links = db
      .select({ photoId: tables.collectionPhotos.photoId })
      .from(tables.collectionPhotos)
      .where(eq(tables.collectionPhotos.collectionId, collectionId))
      .all()
    for (const link of links) memberIds.add(link.photoId)
  }
  if (page.length && collection.kind === 'person') {
    const person = db
      .select({ id: tables.people.id })
      .from(tables.people)
      .where(eq(tables.people.collectionId, collectionId))
      .get()
    if (person) {
      const faces = db
        .select({ photoId: tables.assetFaces.photoId })
        .from(tables.assetFaces)
        .where(eq(tables.assetFaces.personId, person.id))
        .all()
      for (const face of faces) memberIds.add(face.photoId)
    }
  }

  const last = page.at(-1)
  return {
    items: page.map((photo) => ({
      ...photo,
      already: memberIds.has(photo.id),
    })),
    nextCursor:
      rows.length > limit && last
        ? `${last.dateTaken || ''}|${last.id}`
        : null,
  }
})
