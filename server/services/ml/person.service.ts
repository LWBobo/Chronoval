import { and, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

export type PersonVisibility = 'public' | 'login' | 'admin'
export type PersonViewer = 'public' | 'user' | 'admin'

export function normalizeVisibility(person: {
  visibility?: string | null
  isHidden?: boolean | null
}): PersonVisibility {
  if (
    person.visibility === 'public' ||
    person.visibility === 'login' ||
    person.visibility === 'admin'
  ) {
    return person.visibility
  }
  return person.isHidden ? 'admin' : 'public'
}

export function viewerFromActor(actor: {
  user?: { id?: string } | null
  isAdmin?: boolean
}): PersonViewer {
  if (actor.isAdmin) return 'admin'
  if (actor.user?.id) return 'user'
  return 'public'
}

/** 人物相册：public 任何人，login 任意登录账号，admin 仅管理员。 */
export function visibilityAllows(visibility: PersonVisibility, viewer: PersonViewer) {
  if (visibility === 'public') return true
  if (visibility === 'login') return viewer === 'user' || viewer === 'admin'
  return viewer === 'admin'
}

/**
 * 一张照片里只要有一个人当前访问者看不到，整张照片就不可见。
 * 把其中一个人改回公开后，其余人若仍是登录可见或仅管理员，照片继续隐藏。
 */
export function photoAllowedByPeopleSql(viewer: PersonViewer): SQL {
  ensureVisibilityColumn()
  if (viewer === 'admin') return sql`1`
  const restricted =
    viewer === 'user'
      ? sql`(
          ${tables.people.visibility} = 'admin'
          OR (
            (${tables.people.visibility} IS NULL OR ${tables.people.visibility} = '')
            AND ${tables.people.isHidden} = 1
          )
        )`
      : sql`(
          ${tables.people.visibility} IN ('login', 'admin')
          OR (
            (${tables.people.visibility} IS NULL OR ${tables.people.visibility} = '')
            AND ${tables.people.isHidden} = 1
          )
        )`
  const facesHidden = sql`EXISTS (
    SELECT 1
    FROM ${tables.assetFaces}
    INNER JOIN ${tables.people}
      ON ${tables.assetFaces.personId} = ${tables.people.id}
    WHERE ${tables.assetFaces.photoId} = ${tables.photos.id}
      AND ${restricted}
  )`
  const manualHidden = sql`EXISTS (
    SELECT 1
    FROM ${tables.personPhotos}
    INNER JOIN ${tables.people}
      ON ${tables.personPhotos.personId} = ${tables.people.id}
    WHERE ${tables.personPhotos.photoId} = ${tables.photos.id}
      AND ${restricted}
  )`
  return sql`NOT (${facesHidden} OR ${manualHidden})`
}

export function blockedPhotoIdsForActor(actor: {
  user?: { id?: string } | null
  isAdmin?: boolean
}) {
  ensureVisibilityColumn()
  const blocked = new Set<string>()
  if (viewerFromActor(actor) === 'admin') return blocked
  const rows = useDB()
    .select({
      photoId: tables.assetFaces.photoId,
      visibility: tables.people.visibility,
      isHidden: tables.people.isHidden,
    })
    .from(tables.assetFaces)
    .innerJoin(tables.people, eq(tables.assetFaces.personId, tables.people.id))
    .all()
  for (const row of rows) {
    if (row.photoId && !canSeePerson(row, actor)) blocked.add(row.photoId)
  }
  const manual = useDB()
    .select({
      photoId: tables.personPhotos.photoId,
      visibility: tables.people.visibility,
      isHidden: tables.people.isHidden,
    })
    .from(tables.personPhotos)
    .innerJoin(tables.people, eq(tables.personPhotos.personId, tables.people.id))
    .all()
  for (const row of manual) {
    if (row.photoId && !canSeePerson(row, actor)) blocked.add(row.photoId)
  }
  return blocked
}

export function canSeePerson(
  person: { visibility?: string | null; isHidden?: boolean | null },
  actor: { user?: { id?: string } | null; isAdmin?: boolean },
) {
  return visibilityAllows(normalizeVisibility(person), viewerFromActor(actor))
}

let visibilityColumnReady = false

/** 迁移被跳过时补上 visibility，避免「仅登录」写入失败后仍对访客公开。 */
function ensureVisibilityColumn() {
  if (visibilityColumnReady) return
  const sqlite = useSqlite()
  const table = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'people'`)
    .get()
  if (!table) return
  const cols = sqlite.prepare(`PRAGMA table_info(people)`).all() as { name: string }[]
  if (!cols.some((col) => col.name === 'visibility')) {
    sqlite.exec(
      `ALTER TABLE people ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
    )
    sqlite.exec(`UPDATE people SET visibility = 'admin' WHERE is_hidden = 1`)
  }
  visibilityColumnReady = true
}

function recount(personId: string) {
  reconcilePerson(personId)
}

/**
 * Refresh faceCount / thumbnailFaceId after faces change.
 * Soft-deleted (trash) photos do not count. Deletes unnamed people with no live faces.
 */
export function reconcilePerson(personId: string) {
  ensureVisibilityColumn()
  const db = useDB()
  const person = db
    .select()
    .from(tables.people)
    .where(eq(tables.people.id, personId))
    .get()
  if (!person) return

  const faces = db
    .select({
      id: tables.assetFaces.id,
      deletedAt: tables.photos.deletedAt,
    })
    .from(tables.assetFaces)
    .innerJoin(tables.photos, eq(tables.assetFaces.photoId, tables.photos.id))
    .where(eq(tables.assetFaces.personId, personId))
    .all()
    .filter((f) => !f.deletedAt)
  const count = faces.length
  const manualCount = db
    .select({ photoId: tables.personPhotos.photoId })
    .from(tables.personPhotos)
    .where(eq(tables.personPhotos.personId, personId))
    .all().length

  if (count === 0 && manualCount === 0 && !person.name?.trim()) {
    db.delete(tables.people).where(eq(tables.people.id, personId)).run()
    return
  }

  let thumbnailFaceId = person.thumbnailFaceId
  if (
    thumbnailFaceId &&
    !faces.some((f) => f.id === thumbnailFaceId)
  ) {
    thumbnailFaceId = faces[0]?.id ?? null
  }

  db.update(tables.people)
    .set({
      faceCount: count,
      thumbnailFaceId,
      updatedAt: new Date(),
    })
    .where(eq(tables.people.id, personId))
    .run()
}

/** Reconcile many people (e.g. after bulk face deletes). */
export function reconcilePeople(personIds: Iterable<string>) {
  for (const id of new Set(personIds)) {
    if (id) reconcilePerson(id)
  }
}

export function listPeople(options?: {
  viewer?: PersonViewer
  minFaces?: number
}) {
  ensureVisibilityColumn()
  const db = useDB()
  const minFaces = options?.minFaces ?? 1
  const viewer = options?.viewer ?? 'public'
  let rows = db.select().from(tables.people).all()
  rows = rows.filter((p) => visibilityAllows(normalizeVisibility(p), viewer))
  rows = rows.filter(
    (p) => p.faceCount >= minFaces || Boolean(p.name?.trim()),
  )
  rows.sort((a, b) => {
    if (a.name && b.name) return a.name.localeCompare(b.name)
    if (a.name) return -1
    if (b.name) return 1
    return b.faceCount - a.faceCount
  })
  return rows
}

export function getPerson(id: string) {
  ensureVisibilityColumn()
  return useDB()
    .select()
    .from(tables.people)
    .where(eq(tables.people.id, id))
    .get()
}

export function createPerson(name?: string | null) {
  const id = randomUUID()
  useDB()
    .insert(tables.people)
    .values({
      id,
      name: name?.trim() || null,
      ownerId: null,
      visibility: 'public',
      isHidden: false,
      thumbnailFaceId: null,
      faceCount: 0,
    })
    .run()
  return getPerson(id)
}

export function updatePerson(
  id: string,
  patch: {
    name?: string | null
    isHidden?: boolean
    visibility?: PersonVisibility
    thumbnailFaceId?: string | null
  },
) {
  ensureVisibilityColumn()
  const db = useDB()
  const next: {
    name?: string | null
    isHidden?: boolean
    visibility?: PersonVisibility
    thumbnailFaceId?: string | null
    updatedAt: Date
  } = { updatedAt: new Date() }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.thumbnailFaceId !== undefined) next.thumbnailFaceId = patch.thumbnailFaceId
  if (patch.visibility !== undefined) {
    next.visibility = patch.visibility
    next.isHidden = patch.visibility !== 'public'
  } else if (patch.isHidden !== undefined) {
    next.isHidden = patch.isHidden
    next.visibility = patch.isHidden ? 'admin' : 'public'
  }
  db.update(tables.people)
    .set(next)
    .where(eq(tables.people.id, id))
    .run()
  return getPerson(id)
}

/** 删除人物相册。照片保留，其人脸取消归属，不再出现在人物列表。 */
export function deletePeople(ids: string[]) {
  ensureVisibilityColumn()
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (!unique.length) return 0
  const db = useDB()
  db.delete(tables.personPhotos)
    .where(inArray(tables.personPhotos.personId, unique))
    .run()
  db.update(tables.assetFaces)
    .set({ personId: null })
    .where(inArray(tables.assetFaces.personId, unique))
    .run()
  const result = db
    .delete(tables.people)
    .where(inArray(tables.people.id, unique))
    .run()
  return Number(result.changes || 0)
}

function linkedPhotoIds(personId: string) {
  const db = useDB()
  const ids = new Set<string>()
  for (const row of db
    .select({ photoId: tables.assetFaces.photoId })
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.personId, personId))
    .all()) {
    if (row.photoId) ids.add(row.photoId)
  }
  for (const row of db
    .select({ photoId: tables.personPhotos.photoId })
    .from(tables.personPhotos)
    .where(eq(tables.personPhotos.personId, personId))
    .all()) {
    ids.add(row.photoId)
  }
  return ids
}

export function getPersonPhotoIds(personId: string) {
  const db = useDB()
  const ids = [...linkedPhotoIds(personId)]
  if (!ids.length) return []
  return db
    .select()
    .from(tables.photos)
    .where(inArray(tables.photos.id, ids))
    .all()
    .filter((p) => !p.deletedAt)
    .sort((a, b) => {
      const da = a.dateTaken || ''
      const db_ = b.dateTaken || ''
      return db_ < da ? -1 : 1
    })
}

/** 把检测漏掉的照片手动加入人物相册。已通过人脸归属的照片不会重复添加。 */
export function addPhotosToPerson(personId: string, photoIds: string[]) {
  const person = getPerson(personId)
  if (!person) throw createError({ statusCode: 404, message: 'Person not found' })
  const db = useDB()
  const unique = [...new Set(photoIds.map((id) => id.trim()).filter(Boolean))].slice(0, 500)
  const linked = linkedPhotoIds(personId)
  let added = 0
  let already = 0
  for (const photoId of unique) {
    if (linked.has(photoId)) {
      already++
      continue
    }
    const photo = db
      .select({ id: tables.photos.id, deletedAt: tables.photos.deletedAt })
      .from(tables.photos)
      .where(eq(tables.photos.id, photoId))
      .get()
    if (!photo || photo.deletedAt) continue
    db.insert(tables.personPhotos)
      .values({ personId, photoId })
      .onConflictDoNothing()
      .run()
    linked.add(photoId)
    added++
  }
  return { added, already, photoCount: linked.size }
}

export function searchPhotosForPerson(personId: string, query: string, limit = 48) {
  if (!getPerson(personId)) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }
  const db = useDB()
  const cap = Math.min(80, Math.max(1, limit))
  const q = query.trim()
  const columns = {
    id: tables.photos.id,
    title: tables.photos.title,
    thumbnailUrl: tables.photos.thumbnailUrl,
    dateTaken: tables.photos.dateTaken,
  }
  const rows = q
    ? db
        .select(columns)
        .from(tables.photos)
        .where(
          and(
            isNull(tables.photos.deletedAt),
            or(
              like(tables.photos.title, `%${q.replace(/[%_]/g, '')}%`),
              like(tables.photos.id, `%${q.replace(/[%_]/g, '')}%`),
              like(tables.photos.libraryPath, `%${q.replace(/[%_]/g, '')}%`),
            ),
          ),
        )
        .orderBy(desc(tables.photos.dateTaken))
        .limit(cap)
        .all()
    : db
        .select(columns)
        .from(tables.photos)
        .where(isNull(tables.photos.deletedAt))
        .orderBy(desc(tables.photos.dateTaken))
        .limit(cap)
        .all()
  const linked = linkedPhotoIds(personId)
  return rows.map((row) => ({
    ...row,
    already: linked.has(row.id),
  }))
}

export function photoCountByPerson() {
  const groups = new Map<string, Set<string>>()
  const add = (personId: string | null, photoId: string | null) => {
    if (!personId || !photoId) return
    let set = groups.get(personId)
    if (!set) {
      set = new Set()
      groups.set(personId, set)
    }
    set.add(photoId)
  }
  const db = useDB()
  for (const row of db
    .select({
      personId: tables.assetFaces.personId,
      photoId: tables.assetFaces.photoId,
    })
    .from(tables.assetFaces)
    .all()) {
    add(row.personId, row.photoId)
  }
  for (const row of db
    .select({
      personId: tables.personPhotos.personId,
      photoId: tables.personPhotos.photoId,
    })
    .from(tables.personPhotos)
    .all()) {
    add(row.personId, row.photoId)
  }
  return new Map([...groups].map(([id, photos]) => [id, photos.size]))
}

export function getFacesForPhoto(photoId: string) {
  return useDB()
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.photoId, photoId))
    .all()
}

export function reassignFace(faceId: string, personId: string | null) {
  const db = useDB()
  const face = db
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.id, faceId))
    .get()
  if (!face) throw createError({ statusCode: 404, message: 'Face not found' })

  const oldPerson = face.personId
  db.update(tables.assetFaces)
    .set({ personId })
    .where(eq(tables.assetFaces.id, faceId))
    .run()
  if (oldPerson) recount(oldPerson)
  if (personId) recount(personId)
  return db
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.id, faceId))
    .get()
}

/** Merge source person into target; reassign faces; delete source. */
export function mergePeople(targetId: string, sourceIds: string[]) {
  const db = useDB()
  const target = getPerson(targetId)
  if (!target) throw createError({ statusCode: 404, message: 'Target not found' })

  for (const sid of sourceIds) {
    if (sid === targetId) continue
    const source = getPerson(sid)
    if (!source) continue
    db.update(tables.assetFaces)
      .set({ personId: targetId })
      .where(eq(tables.assetFaces.personId, sid))
      .run()
    if (!target.name && source.name) {
      db.update(tables.people)
        .set({ name: source.name, updatedAt: new Date() })
        .where(eq(tables.people.id, targetId))
        .run()
    }
    if (!target.thumbnailFaceId && source.thumbnailFaceId) {
      db.update(tables.people)
        .set({ thumbnailFaceId: source.thumbnailFaceId, updatedAt: new Date() })
        .where(eq(tables.people.id, targetId))
        .run()
    }
    db.delete(tables.people).where(eq(tables.people.id, sid)).run()
  }
  recount(targetId)
  return getPerson(targetId)
}

export function faceThumbnailUrl(faceId: string | null | undefined) {
  if (!faceId) return null
  return `/api/faces/${faceId}/thumbnail`
}

export function personWithMeta(person: typeof tables.people.$inferSelect) {
  const visibility = normalizeVisibility(person)
  return {
    ...person,
    visibility,
    isHidden: visibility !== 'public',
    thumbnailUrl: faceThumbnailUrl(person.thumbnailFaceId),
  }
}
