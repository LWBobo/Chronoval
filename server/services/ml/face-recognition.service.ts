import { eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { faceMaxDistance, faceMinFaces, isFaceEnabled } from './config'
import { isFaceReindexActive } from './face-reindex'
import { reconcilePeople, reconcilePerson } from './person.service'
import { bufferToFloat32, cosineDistance } from './vector'

const log = () => logger.dynamic('ml-face-recog')

function refreshPersonFaceCount(personId: string) {
  reconcilePerson(personId)
}

/** Photo ids that are not in the trash. */
function livePhotoIdSet(): Set<string> {
  return new Set(
    useDB()
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(isNull(tables.photos.deletedAt))
      .all()
      .map((p) => p.id),
  )
}

/**
 * Incremental DBSCAN-style recognition (Immich-aligned):
 * core point if >= minFaces neighbors within maxDistance (incl. self).
 *
 * In-memory personByFace is updated as assignments happen so a single sweep
 * does not create duplicate people for the same cluster.
 */
export async function processFaceRecognition(options?: {
  faceId?: string
  deferred?: boolean
}) {
  if (!(await isFaceEnabled())) return

  // Full reindex: wait until every face-detection job has refreshed embeddings.
  if (isFaceReindexActive()) {
    log().info(
      'Face reindex detections still running; skip recognition to avoid stale clusters',
    )
    return
  }

  const db = useDB()
  const maxDistance = await faceMaxDistance()
  const minFaces = await faceMinFaces()
  const livePhotos = livePhotoIdSet()

  let targets = db
    .select()
    .from(tables.assetFaces)
    .where(isNull(tables.assetFaces.personId))
    .all()
    .filter((f) => f.source === 'ml' && livePhotos.has(f.photoId))

  if (options?.faceId) {
    targets = targets.filter((f) => f.id === options.faceId)
    if (targets.length === 0) {
      const one = db
        .select()
        .from(tables.assetFaces)
        .where(eq(tables.assetFaces.id, options.faceId))
        .get()
      if (
        one &&
        !one.personId &&
        livePhotos.has(one.photoId)
      ) {
        targets = [one]
      }
    }
  }

  const allEmb = db.select().from(tables.faceEmbeddings).all()
  const embMap = new Map(
    allEmb.map((e) => [e.faceId, bufferToFloat32(e.embedding as Buffer)]),
  )
  const allFaces = db
    .select()
    .from(tables.assetFaces)
    .all()
    .filter((f) => livePhotos.has(f.photoId))
  // Live view of assignments for this sweep (DB + in-run updates).
  const personByFace = new Map(
    allFaces.map((f) => [f.id, f.personId as string | null]),
  )

  let assigned = 0
  let created = 0

  for (const face of targets) {
    // May have been assigned earlier in this sweep via a neighbor update.
    if (personByFace.get(face.id)) continue

    const vec = embMap.get(face.id)
    if (!vec) continue

    // Neighbors within maxDistance (include self)
    const neighbors: Array<{
      id: string
      personId: string | null
      distance: number
    }> = []
    for (const other of allFaces) {
      const ov = embMap.get(other.id)
      if (!ov) continue
      const d = other.id === face.id ? 0 : cosineDistance(vec, ov)
      if (d <= maxDistance) {
        neighbors.push({
          id: other.id,
          personId: personByFace.get(other.id) ?? null,
          distance: d,
        })
      }
    }
    neighbors.sort((a, b) => a.distance - b.distance)
    const top = neighbors.slice(0, Math.max(minFaces, neighbors.length))

    const isCore = top.length >= minFaces
    if (!isCore) {
      // Only defer targeted single-face jobs once. A full sweep already sees
      // every unassigned face; enqueueing deferred work per face floods the queue
      // (especially with the nightly sweep).
      if (options?.faceId && !options?.deferred) {
        const pool = globalThis.__workerPool
        await pool?.addTask?.(
          { type: 'photo-face-recognition', faceId: face.id, deferred: true },
          { priority: -1, maxAttempts: 2 },
        )
      }
      continue
    }

    const withPerson = top.find((n) => n.personId)
    let personId = withPerson?.personId || null

    if (!personId) {
      // Search any assigned face among broader neighbors
      const assignedNeighbor = neighbors.find((n) => n.personId)
      personId = assignedNeighbor?.personId || null
    }

    if (!personId) {
      personId = randomUUID()
      db.insert(tables.people)
        .values({
          id: personId,
          name: null,
          isHidden: false,
          thumbnailFaceId: face.id,
          faceCount: 0,
        })
        .run()
      created++
    }

    db.update(tables.assetFaces)
      .set({ personId })
      .where(eq(tables.assetFaces.id, face.id))
      .run()
    personByFace.set(face.id, personId)

    // Also assign unassigned core neighbors
    for (const n of top) {
      if (!personByFace.get(n.id) && n.id !== face.id) {
        db.update(tables.assetFaces)
          .set({ personId })
          .where(eq(tables.assetFaces.id, n.id))
          .run()
        personByFace.set(n.id, personId)
      }
    }

    // Ensure thumbnail
    const person = db
      .select()
      .from(tables.people)
      .where(eq(tables.people.id, personId))
      .get()
    if (person && !person.thumbnailFaceId) {
      db.update(tables.people)
        .set({ thumbnailFaceId: face.id, updatedAt: new Date() })
        .where(eq(tables.people.id, personId))
        .run()
    }

    refreshPersonFaceCount(personId)
    assigned++
  }

  log().success(
    `Recognition done: assigned=${assigned} createdPersons=${created} targets=${targets.length}`,
  )
}

/**
 * Clear ML face→person links so a full reindex can re-cluster.
 * Named people with zero faces are kept; unnamed empty people are removed.
 */
export function resetMlPersonClustering() {
  const db = useDB()
  const linked = db
    .select({
      id: tables.assetFaces.id,
      personId: tables.assetFaces.personId,
    })
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.source, 'ml'))
    .all()
    .filter((f) => f.personId)

  const affected = new Set<string>()
  for (const f of linked) {
    if (f.personId) affected.add(f.personId)
  }

  db.update(tables.assetFaces)
    .set({ personId: null })
    .where(eq(tables.assetFaces.source, 'ml'))
    .run()

  // Also reconcile every person row (covers stale counts / broken thumbs).
  const allPeople = db.select({ id: tables.people.id }).from(tables.people).all()
  for (const p of allPeople) affected.add(p.id)
  reconcilePeople(affected)

  log().info(
    `Reset ML clustering: cleared ${linked.length} face assignment(s), reconciled ${affected.size} person(s)`,
  )
}

/** Queue one global recognition sweep; skip if an identical sweep is already pending. */
export async function queueRecognitionSweep() {
  const pool = globalThis.__workerPool
  if (!pool?.addTask) return

  const pendingSweep = useDB()
    .select({
      id: tables.pipelineQueue.id,
      payload: tables.pipelineQueue.payload,
    })
    .from(tables.pipelineQueue)
    .where(eq(tables.pipelineQueue.status, 'pending'))
    .all()
    .some((row) => {
      const p = row.payload as { type?: string; faceId?: string }
      return p?.type === 'photo-face-recognition' && !p.faceId
    })

  if (pendingSweep) {
    log().debug('Recognition sweep already pending; skip duplicate')
    return
  }

  await pool.addTask(
    { type: 'photo-face-recognition' },
    { priority: 0, maxAttempts: 2 },
  )
}
