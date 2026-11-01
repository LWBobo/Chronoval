import { samePhotoPartition, assertPersonPhotoPartition, currentMlPhoto } from './partition'
import { photoWithMediaColumns } from '../../utils/photo-media'
import { photoAssetSql } from '../../utils/photo-media'
import { collectionAudienceAccess, collectionAudienceSql } from '../collections/access'
import { and, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import { faceMaxDistance } from './config'
import { bufferToFloat32, cosineDistance } from './vector'
import { randomUUID } from 'node:crypto'
import { readCollectionAccess, replaceCollectionAccess } from '../collections/access-grants'

export type PersonVisibility = 'public' | 'login' | 'selected' | 'admin'
export type PersonViewer = 'public' | 'user' | 'admin'

export function normalizeVisibility(person: {
  collectionId?: number | null
  visibility?: string | null
  isHidden?: boolean | null
}): PersonVisibility {
  if (person.collectionId) {
    return readCollectionAccess(person.collectionId).visibility
  }
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
  user?: { id?: string | number } | null
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
export function photoAllowedByPeopleSql(viewer: PersonViewer, userId: number | null = null): SQL {
  return sql`NOT EXISTS(SELECT 1 FROM asset_faces af INNER JOIN people p ON p.id=af.person_id WHERE af.photo_id=${tables.photos.id} AND p.ownership_type='site' AND NOT ${collectionAudienceSql(sql`p.collection_id`, userId, viewer==='admin')})`
}

export function blockedPhotoIdsForActor(actor: {
  user?: { id?: string | number } | null
  isAdmin?: boolean
}) {
  ensureVisibilityColumn()
  const blocked = new Set<string>()
  if (viewerFromActor(actor) === 'admin') return blocked
  const rows = useDB()
    .select({
      photoId: tables.assetFaces.photoId,
      collectionId: tables.people.collectionId,
    })
    .from(tables.assetFaces)
    .innerJoin(tables.people, eq(tables.assetFaces.personId, tables.people.id))
    .where(eq(tables.people.ownershipType, 'site'))
    .all()
  for (const row of rows) {
    if (row.photoId && !canSeePerson(row, actor)) blocked.add(row.photoId)
  }
  return blocked
}

export function canSeePerson(
  person: {
    collectionId?: number | null
    visibility?: string | null
    isHidden?: boolean | null
  },
  actor: { user?: { id?: string | number } | null; isAdmin?: boolean },
) {
  if (!person.collectionId) return false
  return collectionAudienceAccess(person.collectionId, { user: actor.user ? { id: Number(actor.user.id) } as any : null, isAdmin: !!actor.isAdmin })
}

function ensureVisibilityColumn() {}

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
  if (
    person.origin !== 'manual' &&
    count === 0 &&
    !person.name?.trim()
  ) {
    if (person.collectionId) {
      db.delete(tables.collections)
        .where(eq(tables.collections.id, person.collectionId))
        .run()
    }
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
  actor?: import('../../utils/access').Actor
}) {
  ensureVisibilityColumn()
  const db = useDB()
  const minFaces = options?.minFaces ?? 1
  const viewer = options?.viewer ?? 'public'
  let rows = db.select().from(tables.people).all()
  rows = rows.filter((p) => options?.actor ? canSeePerson(p,options.actor) : viewer === 'admin' || (p.ownershipType === 'site' && visibilityAllows(normalizeVisibility(p),viewer)))
  rows = rows.filter(
    (p) => p.faceCount >= minFaces || Boolean(p.name?.trim()),
  )
  rows.sort((a, b) => {
    if (a.name && b.name) return a.name.localeCompare(b.name)
    if (a.name) return -1
    if (b.name) return 1
    return b.faceCount - a.faceCount
  })
  return rows.map((person) => {
    const visibility = normalizeVisibility(person)
    return { ...person, visibility, isHidden: visibility !== 'public' }
  })
}

export function getPerson(id: string) {
  ensureVisibilityColumn()
  const person = useDB()
    .select()
    .from(tables.people)
    .where(eq(tables.people.id, id))
    .get()
  if (!person) return undefined
  const visibility = normalizeVisibility(person)
  return { ...person, visibility, isHidden: visibility !== 'public' }
}

export function ensurePersonCollection(
  personId: string,
  audience?: PersonVisibility,
) {
  const db = useDB()
  const person = db
    .select()
    .from(tables.people)
    .where(eq(tables.people.id, personId))
    .get()
  if (!person) return null
  let collectionId = person.collectionId
  if (!collectionId) {
    const created = db
      .insert(tables.collections)
      .values({
        kind: 'person',
        ownershipType: person.ownershipType,
        ownerId: person.ownerId,
        visibility: person.ownershipType === 'user' ? 'admin' : audience ?? 'public',
        title: person.name,
        showOnGallery: true,
        showOnAlbums: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: tables.collections.id })
      .get()
    collectionId = created.id
    db.update(tables.people)
      .set({ collectionId, updatedAt: new Date() })
      .where(eq(tables.people.id, personId))
      .run()
  }
  return collectionId
}

export function createPerson(
  name?: string | null,
  options?: { origin?: 'ml' | 'manual'; visibility?: PersonVisibility; ownerId?:number|null; ownershipType?:'site'|'user' },
) {
  const id = randomUUID()
  const visibility = options?.visibility ?? 'public'
  useDB()
    .insert(tables.people)
    .values({
      id,
      name: name?.trim() || null,
      ownerId: options?.ownerId??null,
      ownershipType:options?.ownershipType??'site',
      origin: options?.origin ?? 'ml',
      thumbnailFaceId: null,
      faceCount: 0,
    })
    .run()
  ensurePersonCollection(id, visibility)
  return getPerson(id)
}

export function updatePerson(
  id: string,
  patch: {
    name?: string | null
    thumbnailFaceId?: string | null
  },
) {
  ensureVisibilityColumn()
  const db = useDB()
  const next: {
    name?: string | null
    thumbnailFaceId?: string | null
    updatedAt: Date
  } = { updatedAt: new Date() }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.thumbnailFaceId !== undefined) next.thumbnailFaceId = patch.thumbnailFaceId
  db.update(tables.people)
    .set(next)
    .where(eq(tables.people.id, id))
    .run()
  ensurePersonCollection(id)
  return getPerson(id)
}

/** 删除人物相册。照片保留，其人脸取消归属，不再出现在人物列表。 */
export function deletePeople(ids: string[]) {
  ensureVisibilityColumn()
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (!unique.length) return 0
  const db = useDB()
  const rows = db
    .select({ collectionId: tables.people.collectionId })
    .from(tables.people)
    .where(inArray(tables.people.id, unique))
    .all()
  const collectionIds = rows
    .map((row) => row.collectionId)
    .filter((id): id is number => id != null)
  if (collectionIds.length) {
    db.delete(tables.collections)
      .where(inArray(tables.collections.id, collectionIds))
      .run()
  }
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
  return ids
}

export function getPersonPhotoIds(personId: string) {
  const db = useDB()
  const ids = [...linkedPhotoIds(personId)]
  if (!ids.length) return []
  return db
    .select(photoWithMediaColumns())
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
    assertPersonPhotoPartition(person,photoId)
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
    db.insert(tables.assetFaces)
      .values({
        id: randomUUID(),
        photoId,
        personId,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        imageWidth: 0,
        imageHeight: 0,
        score: 0,
        source: 'manual',
        pinned: false,
      })
      .run()
    linked.add(photoId)
    added++
  }
  reconcilePerson(personId)
  return { added, already, photoCount: linked.size }
}

export function searchPhotosForPerson(
  personId: string,
  query: string,
  limit = 48,
  cursor = '',
) {
  const selectedPerson=getPerson(personId)
  if (!selectedPerson) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }
  const db = useDB()
  const cap = Math.min(80, Math.max(1, limit))
  const q = query.trim()
  const term = q ? `%${q.replace(/[%_]/g, '')}%` : ''
  const separator = cursor.indexOf('|')
  const cursorDate = separator >= 0 ? cursor.slice(0, separator) : ''
  const cursorId = separator >= 0 ? cursor.slice(separator + 1) : ''
  const filters: SQL[] = [
    eq(tables.photos.ownershipType,selectedPerson.ownershipType),
    selectedPerson.ownerId===null?isNull(tables.photos.ownerId):eq(tables.photos.ownerId,selectedPerson.ownerId),
    eq(tables.photos.transferState,'idle'),eq(tables.photos.processingStatus,'ready'),
    isNull(tables.photos.deletedAt),
    or(
      isNull(tables.photos.libraryId),
      sql`EXISTS (
        SELECT 1 FROM ${tables.libraries}
        WHERE ${tables.libraries.id} = ${tables.photos.libraryId}
          AND ${tables.libraries.enabled} = 1
      )`,
    )!,
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
      COALESCE(${tables.photos.dateTaken}, '') < ${cursorDate}
      OR (
        COALESCE(${tables.photos.dateTaken}, '') = ${cursorDate}
        AND ${tables.photos.id} < ${cursorId}
      )
    )`)
  }

  const rows = db
    .select({
      id: tables.photos.id,
      title: tables.photos.title,
      thumbnailUrl: photoAssetSql('thumbnail'),
      dateTaken: tables.photos.dateTaken,
    })
    .from(tables.photos)
    .where(and(...filters))
    .orderBy(
      sql`COALESCE(${tables.photos.dateTaken}, '') DESC`,
      desc(tables.photos.id),
    )
    .limit(cap + 1)
    .all()
  const page = rows.slice(0, cap)
  const linked = linkedPhotoIds(personId)
  const last = page.at(-1)
  return {
    photos: page.map((row) => ({
      ...row,
      already: linked.has(row.id),
    })),
    nextCursor:
      rows.length > cap && last
        ? `${last.dateTaken || ''}|${last.id}`
        : null,
  }
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
  return new Map([...groups].map(([id, photos]) => [id, photos.size]))
}

export function getFacesForPhoto(photoId: string) {
  return useDB()
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.photoId, photoId))
    .all()
}

/** 手建人物的照片在检测出唯一一张脸后，把这张脸固定为锚点。 */
export async function anchorManualMembers(photoId: string) {
  const db = useDB()
  const snapshot=currentMlPhoto(photoId)
  if(!snapshot)return
  const manualFaces = db
    .select({ personId: tables.assetFaces.personId })
    .from(tables.assetFaces)
    .where(
      and(
        eq(tables.assetFaces.photoId, photoId),
        eq(tables.assetFaces.source, 'manual'),
      ),
    )
    .all()
  const personIds = new Set(
    manualFaces
      .map((row) => row.personId)
      .filter((id): id is string => Boolean(id)),
  )
  if (personIds.size !== 1) return
  const personId = [...personIds][0]!
  const person = getPerson(personId)
  if (!person || person.origin !== 'manual'||!samePhotoPartition(person,snapshot)) return
  const detected = db
    .select()
    .from(tables.assetFaces)
    .where(
      and(
        eq(tables.assetFaces.photoId, photoId),
        eq(tables.assetFaces.source, 'ml'),
      ),
    )
    .all()
  if (detected.length !== 1) return
  const face = detected[0]!
  if (face.personId && face.personId !== personId) {
    const current = getPerson(face.personId)
    if (!current || current.origin === 'manual' || current.name?.trim()) return
  }
  db.update(tables.assetFaces)
    .set({ personId, pinned: true })
    .where(eq(tables.assetFaces.id, face.id))
    .run()
  if (face.personId && face.personId !== personId) {
    const maxDistance = await faceMaxDistance()
    const current=currentMlPhoto(photoId)
    if(!current||!samePhotoPartition(current,snapshot))return
    const anchorEmb = db
      .select()
      .from(tables.faceEmbeddings)
      .where(eq(tables.faceEmbeddings.faceId, face.id))
      .get()
    const anchorVec = anchorEmb
      ? bufferToFloat32(anchorEmb.embedding as Buffer)
      : null
    const others = db
      .select()
      .from(tables.assetFaces)
      .where(eq(tables.assetFaces.personId, face.personId))
      .all()
    for (const other of others) {
      if (other.id === face.id) continue
      const otherPhoto=currentMlPhoto(other.photoId)
      if(!otherPhoto||!samePhotoPartition(otherPhoto,snapshot))continue
      if (!anchorVec) continue
      const otherEmb = db
        .select()
        .from(tables.faceEmbeddings)
        .where(eq(tables.faceEmbeddings.faceId, other.id))
        .get()
      if (!otherEmb) continue
      const distance = cosineDistance(
        anchorVec,
        bufferToFloat32(otherEmb.embedding as Buffer),
      )
      if (distance > maxDistance) continue
      db.update(tables.assetFaces)
        .set({ personId })
        .where(eq(tables.assetFaces.id, other.id))
        .run()
    }
    reconcilePerson(face.personId)
  }
  reconcilePerson(personId)
}

export function reassignFace(faceId: string, personId: string | null) {
  const db = useDB()
  const face = db
    .select()
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.id, faceId))
    .get()
  if (!face) throw createError({ statusCode: 404, message: 'Face not found' })

  const photo=currentMlPhoto(face.photoId)
  if(!photo)throw createError({statusCode:409,message:'照片暂不可操作'})
  if(personId){const target=getPerson(personId);if(!target)throw createError({statusCode:404,message:'Person not found'});assertPersonPhotoPartition(target,face.photoId)}
  const oldPerson = face.personId
  db.update(tables.assetFaces)
    .set({ personId, pinned: personId != null })
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
    if(!samePhotoPartition(source,target))throw createError({statusCode:409,message:'不能合并不同所有者分区的人物'})
    if(source.collectionId&&target.collectionId){
      const policy=(id:number)=>{
        const row=db.select().from(tables.collections).where(eq(tables.collections.id,id)).get()!
        const viewers=db.select({id:tables.collectionViewers.userId}).from(tables.collectionViewers).where(eq(tables.collectionViewers.collectionId,id)).all().map(v=>v.id).sort((a,b)=>a-b)
        const exemptions=db.select({id:tables.collectionPasswordExemptions.userId}).from(tables.collectionPasswordExemptions).where(eq(tables.collectionPasswordExemptions.collectionId,id)).all().map(v=>v.id).sort((a,b)=>a-b)
        return JSON.stringify([row.visibility,row.passwordHash,row.passwordExemptMode,viewers,exemptions])
      }
      if(policy(source.collectionId)!==policy(target.collectionId))throw createError({statusCode:409,message:'人物相册权限或密码不同，请先明确统一后再合并'})
    }
    for(const photo of getPersonPhotoIds(source.id))assertPersonPhotoPartition(target,photo.id)
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
    if(source.collectionId)db.delete(tables.collections).where(eq(tables.collections.id,source.collectionId)).run()
    else db.delete(tables.people).where(eq(tables.people.id, sid)).run()
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
    aclVersion: person.collectionId ? useDB().select({version:tables.collections.aclVersion}).from(tables.collections).where(eq(tables.collections.id,person.collectionId)).get()?.version : null,
    visibility,
    isHidden: visibility !== 'public',
    thumbnailUrl: faceThumbnailUrl(person.thumbnailFaceId),
  }
}
