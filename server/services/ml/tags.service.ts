import { and, eq, inArray } from 'drizzle-orm'
import { encodeText } from './client'
import { clipModel, isClipEnabled } from './config'
import { bufferToFloat32, cosineDistance, float32ToBuffer } from './vector'

const log = () => logger.dynamic('ml-tags')

/** 自动标签至少要达到的余弦相似度。宁缺毋滥，漏标仍能靠向量搜到。 */
const AUTO_TAG_MIN_SCORE = 0.25
/** 一张照片最多保留的自动标签数。人工标签不占这个名额。 */
const AUTO_TAG_LIMIT = 5

export class TagConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TagConflictError'
  }
}

export interface TagInput {
  name: string
  prompt?: string
  aliases?: string[]
  enabled?: boolean
}

export interface TagRecord {
  id: number
  name: string
  prompt: string
  enabled: boolean
  aliases: string[]
  appliedCount: number
}

export interface PhotoTagRecord {
  tagId: number
  name: string
  source: 'auto' | 'manual'
  decision: 'apply' | 'reject'
  score: number | null
}

export interface TagSearchHit {
  photoId: string
  score: number
  manual: boolean
}

function normalizeKey(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function cleanLabel(value: string, max: number) {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return ''
  return trimmed.slice(0, max)
}

function defaultPrompt(name: string) {
  return `一张${name}的照片`
}

/** 逗号、分号、冒号、顿号、斜线、横线，含中英文写法。 */
const ALIAS_SEPARATORS = /[,，;；:：、|/\\\-–—－]+/

function readAliases(raw: string[] | undefined, nameKey: string) {
  const seen = new Set<string>()
  const aliases: Array<{ alias: string; aliasKey: string }> = []
  for (const item of raw || []) {
    for (const part of item.split(ALIAS_SEPARATORS)) {
      const alias = cleanLabel(part, 32)
      const aliasKey = normalizeKey(alias)
      if (!aliasKey || aliasKey === nameKey || seen.has(aliasKey)) continue
      seen.add(aliasKey)
      aliases.push({ alias, aliasKey })
    }
  }
  if (aliases.length > 20) {
    throw new TagConflictError('一个标签最多 20 个同义词')
  }
  return aliases
}

function assertKeysFree(
  nameKey: string,
  aliasKeys: string[],
  exceptTagId?: number,
) {
  const db = useDB()
  const tags = db.select().from(tables.mlTags).all()
  const aliases = db.select().from(tables.mlTagAliases).all()
  const occupied = new Map<string, number>()
  for (const tag of tags) {
    if (tag.id === exceptTagId) continue
    occupied.set(tag.nameKey, tag.id)
  }
  for (const alias of aliases) {
    if (alias.tagId === exceptTagId) continue
    occupied.set(alias.aliasKey, alias.tagId)
  }

  if (occupied.has(nameKey)) {
    throw new TagConflictError('标签名或同义词已被占用')
  }
  for (const key of aliasKeys) {
    if (key === nameKey || occupied.has(key)) {
      throw new TagConflictError('标签名或同义词已被占用')
    }
  }
}

function replaceAliases(
  tagId: number,
  aliases: Array<{ alias: string; aliasKey: string }>,
) {
  const db = useDB()
  db.delete(tables.mlTagAliases)
    .where(eq(tables.mlTagAliases.tagId, tagId))
    .run()
  for (const alias of aliases) {
    db.insert(tables.mlTagAliases)
      .values({
        tagId,
        alias: alias.alias,
        aliasKey: alias.aliasKey,
      })
      .run()
  }
}

export function listTags(): TagRecord[] {
  const db = useDB()
  const tags = db.select().from(tables.mlTags).all()
  const aliases = db.select().from(tables.mlTagAliases).all()
  const byTag = new Map<number, string[]>()
  for (const alias of aliases) {
    const list = byTag.get(alias.tagId) || []
    list.push(alias.alias)
    byTag.set(alias.tagId, list)
  }
  const appliedCount = new Map<number, number>()
  for (const row of db
    .select({ tagId: tables.photoMlTags.tagId })
    .from(tables.photoMlTags)
    .where(eq(tables.photoMlTags.decision, 'apply'))
    .all()) {
    appliedCount.set(row.tagId, (appliedCount.get(row.tagId) || 0) + 1)
  }
  return tags
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      prompt: tag.prompt,
      enabled: tag.enabled,
      aliases: byTag.get(tag.id) || [],
      appliedCount: appliedCount.get(tag.id) || 0,
    }))
}

export function createTag(input: TagInput): TagRecord {
  const name = cleanLabel(input.name || '', 32)
  const nameKey = normalizeKey(name)
  if (!nameKey) throw new TagConflictError('标签名不能为空')
  const prompt = cleanLabel(input.prompt || '', 200) || defaultPrompt(name)
  const aliases = readAliases(input.aliases, nameKey)
  assertKeysFree(
    nameKey,
    aliases.map((item) => item.aliasKey),
  )

  const db = useDB()
  const created = db
    .insert(tables.mlTags)
    .values({
      name,
      nameKey,
      prompt,
      enabled: input.enabled !== false,
    })
    .returning()
    .get()
  if (!created) throw new Error('Failed to create tag')
  replaceAliases(created.id, aliases)
  return {
    id: created.id,
    name: created.name,
    prompt: created.prompt,
    enabled: created.enabled,
    aliases: aliases.map((item) => item.alias),
    appliedCount: 0,
  }
}

export function updateTag(tagId: number, input: TagInput): TagRecord {
  const db = useDB()
  const current = db
    .select()
    .from(tables.mlTags)
    .where(eq(tables.mlTags.id, tagId))
    .get()
  if (!current) throw new TagConflictError('标签不存在')

  const name = cleanLabel(input.name ?? current.name, 32)
  const nameKey = normalizeKey(name)
  if (!nameKey) throw new TagConflictError('标签名不能为空')
  const prompt =
    input.prompt === undefined
      ? current.prompt
      : cleanLabel(input.prompt, 200) || defaultPrompt(name)
  const aliases =
    input.aliases === undefined
      ? db
          .select()
          .from(tables.mlTagAliases)
          .where(eq(tables.mlTagAliases.tagId, tagId))
          .all()
          .map((row) => ({ alias: row.alias, aliasKey: row.aliasKey }))
      : readAliases(input.aliases, nameKey)
  assertKeysFree(
    nameKey,
    aliases.map((item) => item.aliasKey),
    tagId,
  )

  const enabled = input.enabled === undefined ? current.enabled : input.enabled
  const promptChanged = prompt !== current.prompt
  db.update(tables.mlTags)
    .set({
      name,
      nameKey,
      prompt,
      enabled,
      ...(promptChanged
        ? { vectorModel: null, vectorPrompt: null, embedding: null, dim: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(tables.mlTags.id, tagId))
    .run()
  replaceAliases(tagId, aliases)

  if (!enabled) {
    db.delete(tables.photoMlTags)
      .where(
        and(
          eq(tables.photoMlTags.tagId, tagId),
          eq(tables.photoMlTags.source, 'auto'),
        ),
      )
      .run()
  }

  return {
    id: tagId,
    name,
    prompt,
    enabled,
    aliases: aliases.map((item) => item.alias),
    appliedCount: db
      .select({ photoId: tables.photoMlTags.photoId })
      .from(tables.photoMlTags)
      .where(
        and(
          eq(tables.photoMlTags.tagId, tagId),
          eq(tables.photoMlTags.decision, 'apply'),
        ),
      )
      .all().length,
  }
}

export function deleteTag(tagId: number) {
  const db = useDB()
  db.delete(tables.photoMlTags)
    .where(eq(tables.photoMlTags.tagId, tagId))
    .run()
  db.delete(tables.mlTagAliases)
    .where(eq(tables.mlTagAliases.tagId, tagId))
    .run()
  db.delete(tables.mlTags).where(eq(tables.mlTags.id, tagId)).run()
}

interface ReadyVector {
  tagId: number
  vec: Float32Array
}

async function readyTagVectors(model: string): Promise<ReadyVector[]> {
  const db = useDB()
  const tags = db
    .select()
    .from(tables.mlTags)
    .where(eq(tables.mlTags.enabled, true))
    .all()
  const ready: ReadyVector[] = []

  for (const tag of tags) {
    if (
      tag.embedding &&
      tag.vectorModel === model &&
      tag.vectorPrompt === tag.prompt &&
      (tag.dim ?? 0) > 0
    ) {
      ready.push({
        tagId: tag.id,
        vec: bufferToFloat32(tag.embedding as Buffer),
      })
      continue
    }

    const encoded = await encodeText(tag.prompt, model)
    db.update(tables.mlTags)
      .set({
        vectorModel: encoded.model || model,
        vectorPrompt: tag.prompt,
        embedding: float32ToBuffer(encoded.embedding),
        dim: encoded.dim,
        updatedAt: new Date(),
      })
      .where(eq(tables.mlTags.id, tag.id))
      .run()
    ready.push({
      tagId: tag.id,
      vec: Float32Array.from(encoded.embedding),
    })
  }

  return ready
}

/** 用已有图片向量和候选标签的文本向量比对，只改自动记录。 */
export async function assignAutoTagsForPhoto(photoId: string) {
  if (!(await isClipEnabled())) return

  const db = useDB()
  const photo = db
    .select({
      id: tables.photos.id,
      type: tables.photos.type,
      deletedAt: tables.photos.deletedAt,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
  if (!photo || photo.deletedAt || photo.type === 'video') return

  const model = await clipModel()
  const embedding = db
    .select()
    .from(tables.photoEmbeddings)
    .where(eq(tables.photoEmbeddings.photoId, photoId))
    .get()
  if (!embedding || embedding.model !== model) return

  const vectors = await readyTagVectors(model)
  const manualIds = new Set(
    db
      .select({ tagId: tables.photoMlTags.tagId })
      .from(tables.photoMlTags)
      .where(
        and(
          eq(tables.photoMlTags.photoId, photoId),
          eq(tables.photoMlTags.source, 'manual'),
        ),
      )
      .all()
      .map((row) => row.tagId),
  )

  const photoVec = bufferToFloat32(embedding.embedding as Buffer)
  const ranked = vectors
    .filter((item) => !manualIds.has(item.tagId))
    .map((item) => ({
      tagId: item.tagId,
      score: 1 - cosineDistance(photoVec, item.vec),
    }))
    .filter((item) => item.score >= AUTO_TAG_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, AUTO_TAG_LIMIT)
  const keep = new Set(ranked.map((item) => item.tagId))

  const existingAuto = db
    .select({ tagId: tables.photoMlTags.tagId })
    .from(tables.photoMlTags)
    .where(
      and(
        eq(tables.photoMlTags.photoId, photoId),
        eq(tables.photoMlTags.source, 'auto'),
      ),
    )
    .all()
  for (const row of existingAuto) {
    if (keep.has(row.tagId)) continue
    db.delete(tables.photoMlTags)
      .where(
        and(
          eq(tables.photoMlTags.photoId, photoId),
          eq(tables.photoMlTags.tagId, row.tagId),
        ),
      )
      .run()
  }

  for (const item of ranked) {
    db.insert(tables.photoMlTags)
      .values({
        photoId,
        tagId: item.tagId,
        source: 'auto',
        decision: 'apply',
        score: item.score,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [tables.photoMlTags.photoId, tables.photoMlTags.tagId],
        set: {
          source: 'auto',
          decision: 'apply',
          score: item.score,
          updatedAt: new Date(),
        },
      })
      .run()
  }
}

export async function assignAutoTagsForAll() {
  const db = useDB()
  const rows = db
    .select({ photoId: tables.photoEmbeddings.photoId })
    .from(tables.photoEmbeddings)
    .all()
  let photos = 0
  for (const row of rows) {
    await assignAutoTagsForPhoto(row.photoId)
    photos++
  }
  log().success(`Auto-tagged ${photos} embedded photos`)
  return { photos }
}

/** 已打上（decision=apply）的标签名，按照片分组。供画廊筛选，不改 photos.tags。 */
export function appliedTagNamesForPhotos(photoIds: string[]): Map<string, string[]> {
  const names = new Map<string, string[]>()
  if (!photoIds.length) return names

  const db = useDB()
  const chunkSize = 400
  for (let offset = 0; offset < photoIds.length; offset += chunkSize) {
    const chunk = photoIds.slice(offset, offset + chunkSize)
    const rows = db
      .select({
        photoId: tables.photoMlTags.photoId,
        name: tables.mlTags.name,
      })
      .from(tables.photoMlTags)
      .innerJoin(tables.mlTags, eq(tables.mlTags.id, tables.photoMlTags.tagId))
      .where(
        and(
          eq(tables.photoMlTags.decision, 'apply'),
          inArray(tables.photoMlTags.photoId, chunk),
        ),
      )
      .all()
    for (const row of rows) {
      const list = names.get(row.photoId) || []
      if (!list.includes(row.name)) list.push(row.name)
      names.set(row.photoId, list)
    }
  }
  return names
}

export function listPhotoTags(photoId: string): PhotoTagRecord[] {
  const db = useDB()
  const rows = db
    .select({
      tagId: tables.photoMlTags.tagId,
      name: tables.mlTags.name,
      source: tables.photoMlTags.source,
      decision: tables.photoMlTags.decision,
      score: tables.photoMlTags.score,
    })
    .from(tables.photoMlTags)
    .innerJoin(tables.mlTags, eq(tables.mlTags.id, tables.photoMlTags.tagId))
    .where(eq(tables.photoMlTags.photoId, photoId))
    .all()
  return rows
    .map((row) => ({
      tagId: row.tagId,
      name: row.name,
      source: row.source,
      decision: row.decision,
      score: row.score,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export async function setPhotoTagDecision(
  photoId: string,
  tagId: number,
  action: 'apply' | 'reject' | 'clear',
) {
  const db = useDB()
  const tag = db
    .select({ id: tables.mlTags.id })
    .from(tables.mlTags)
    .where(eq(tables.mlTags.id, tagId))
    .get()
  if (!tag) throw new TagConflictError('标签不存在')

  if (action === 'clear') {
    db.delete(tables.photoMlTags)
      .where(
        and(
          eq(tables.photoMlTags.photoId, photoId),
          eq(tables.photoMlTags.tagId, tagId),
        ),
      )
      .run()
  } else {
    db.insert(tables.photoMlTags)
      .values({
        photoId,
        tagId,
        source: 'manual',
        decision: action,
        score: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [tables.photoMlTags.photoId, tables.photoMlTags.tagId],
        set: {
          source: 'manual',
          decision: action,
          score: null,
          updatedAt: new Date(),
        },
      })
      .run()
  }

  try {
    await assignAutoTagsForPhoto(photoId)
  } catch (err) {
    log().warn(`Auto tag refresh skipped for ${photoId}`, err)
  }
  return listPhotoTags(photoId)
}

function queryMatchesLabel(queryKey: string, tokens: string[], labelKey: string) {
  if (!labelKey) return false
  if (queryKey === labelKey || tokens.includes(labelKey)) return true
  return labelKey.length >= 2 && queryKey.includes(labelKey)
}

/** 查询命中候选标签时，返回应排在向量结果前面的照片。 */
export function searchTagHits(query: string): TagSearchHit[] {
  const queryKey = normalizeKey(query)
  if (!queryKey) return []
  const tokens = queryKey.split(' ').filter(Boolean)

  const db = useDB()
  const tags = db.select().from(tables.mlTags).all()
  const aliases = db.select().from(tables.mlTagAliases).all()
  const labelsByTag = new Map<number, string[]>()
  for (const tag of tags) {
    labelsByTag.set(tag.id, [tag.nameKey])
  }
  for (const alias of aliases) {
    const list = labelsByTag.get(alias.tagId)
    if (!list) continue
    list.push(alias.aliasKey)
  }

  const matched = new Set<number>()
  for (const [tagId, labels] of labelsByTag) {
    if (labels.some((label) => queryMatchesLabel(queryKey, tokens, label))) {
      matched.add(tagId)
    }
  }
  if (!matched.size) return []

  const rows = db
    .select({
      photoId: tables.photoMlTags.photoId,
      tagId: tables.photoMlTags.tagId,
      source: tables.photoMlTags.source,
      decision: tables.photoMlTags.decision,
      score: tables.photoMlTags.score,
      deletedAt: tables.photos.deletedAt,
    })
    .from(tables.photoMlTags)
    .innerJoin(tables.photos, eq(tables.photos.id, tables.photoMlTags.photoId))
    .all()

  const best = new Map<string, TagSearchHit>()
  for (const row of rows) {
    if (row.deletedAt || row.decision !== 'apply' || !matched.has(row.tagId)) {
      continue
    }
    const manual = row.source === 'manual'
    const score = manual ? 1 : row.score || 0
    const prev = best.get(row.photoId)
    if (
      !prev ||
      (manual && !prev.manual) ||
      (manual === prev.manual && score > prev.score)
    ) {
      best.set(row.photoId, { photoId: row.photoId, score, manual })
    }
  }

  return [...best.values()].sort((a, b) => {
    if (a.manual !== b.manual) return a.manual ? -1 : 1
    return b.score - a.score
  })
}
