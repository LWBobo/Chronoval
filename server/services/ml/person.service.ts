import { eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

function recount(personId: string) {
  reconcilePerson(personId)
}

/**
 * Refresh faceCount / thumbnailFaceId after faces change.
 * Soft-deleted (trash) photos do not count. Deletes unnamed people with no live faces.
 */
export function reconcilePerson(personId: string) {
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

  if (count === 0 && !person.name?.trim()) {
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
  includeHidden?: boolean
  minFaces?: number
}) {
  const db = useDB()
  const minFaces = options?.minFaces ?? 1
  let rows = db.select().from(tables.people).all()
  if (!options?.includeHidden) {
    rows = rows.filter((p) => !p.isHidden)
  }
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
    thumbnailFaceId?: string | null
  },
) {
  const db = useDB()
  db.update(tables.people)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tables.people.id, id))
    .run()
  return getPerson(id)
}

export function getPersonPhotoIds(personId: string) {
  const db = useDB()
  const faces = db
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.personId, personId))
    .all()
  const ids = [...new Set(faces.map((f) => f.photoId))]
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
  return {
    ...person,
    thumbnailUrl: faceThumbnailUrl(person.thumbnailFaceId),
  }
}
