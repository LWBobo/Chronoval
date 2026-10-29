import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import type { PlaceSearchHit } from './geocoding'

/** 转义 LIKE 通配符，避免用户输入 `%` / `_` 干扰匹配。 */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

/** 去掉常见行政区后缀，便于「河南」也能命中「河南省」。 */
function stripAdminSuffix(value: string): string {
  return value.replace(
    /(特别行政区|自治区|壮族自治区|回族自治区|维吾尔自治区|省|市|地区|盟|州|县|区|旗|镇|乡|街道)$/u,
    '',
  )
}

function buildLabel(row: {
  name: string
  district: string | null
  city: string | null
  province: string | null
  country: string | null
  placeType: string | null
}): string {
  // 自下而上拼行政区路径，便于同名地点区分（如多省「太平镇」）
  const trail: string[] = []
  for (const part of [row.district, row.city, row.province, row.country]) {
    if (!part?.trim()) continue
    if (part === row.name) continue
    if (trail.includes(part)) continue
    trail.push(part)
  }

  if (trail.length === 0) return row.name
  return `${row.name}（${trail.join(' · ')}）`
}

/**
 * 在本地 geocode_places 表中按中文名 / 别名 / 拼音搜索。
 *
 * 排序规则（满足「河南省 → 省会/省条目 → 地级市 → 区县 → 乡镇」）：
 * 1. 名称匹配强度（精确 > 前缀 > 包含 > 仅行政区扩展）
 * 2. 行政层级 place_type（province > city > district > town > …）
 * 3. CSV 中的 priority
 */
export async function searchLocalPlaces(
  query: string,
  limit = 20,
): Promise<PlaceSearchHit[]> {
  const q = query.trim()
  if (!q) return []

  const db = useDB()
  const places = tables.geocodePlaces
  const qLower = q.toLowerCase()
  const qBare = stripAdminSuffix(q) || q
  const pattern = `%${escapeLike(q)}%`
  const patternLower = `%${escapeLike(qLower)}%`
  const prefix = `${escapeLike(q)}%`
  const barePrefix = `${escapeLike(qBare)}%`

  // 名称 / 拼音命中：所有类型
  const nameMatch = or(
    sql`${places.name} like ${pattern} escape '\\'`,
    sql`lower(coalesce(${places.nameEn}, '')) like ${patternLower} escape '\\'`,
    sql`lower(coalesce(${places.aliases}, '')) like ${patternLower} escape '\\'`,
    sql`lower(coalesce(${places.pinyin}, '')) like ${patternLower} escape '\\'`,
    sql`lower(coalesce(${places.pinyinAbbr}, '')) like ${patternLower} escape '\\'`,
  )

  // 行政区扩展：输入省/市/区名时带出下级，但限制类型以免乡镇刷屏
  const adminExpand = or(
    and(
      or(
        eq(places.province, q),
        sql`${places.province} like ${prefix} escape '\\'`,
        and(
          sql`length(${qBare}) >= 2`,
          sql`${places.province} like ${barePrefix} escape '\\'`,
        ),
      ),
      sql`${places.placeType} in ('province', 'city', 'district')`,
    ),
    and(
      or(
        eq(places.city, q),
        sql`${places.city} like ${prefix} escape '\\'`,
        and(
          sql`length(${qBare}) >= 2`,
          sql`${places.city} like ${barePrefix} escape '\\'`,
        ),
      ),
      sql`${places.placeType} in ('city', 'district', 'town')`,
    ),
    and(
      or(
        eq(places.district, q),
        sql`${places.district} like ${prefix} escape '\\'`,
      ),
      sql`${places.placeType} in ('district', 'town')`,
    ),
  )

  const matchClause = or(nameMatch, adminExpand)

  const typeRank = sql`(
    case coalesce(${places.placeType}, '')
      when 'province' then 700
      when 'city' then 600
      when 'district' then 500
      when 'town' then 400
      when 'landmark' then 300
      when 'poi' then 200
      else 100
    end
  )`

  const nameScore = sql`(
    case
      when ${places.name} = ${q} then 550
      when ${places.name} = ${`${qBare}省`} then 540
      when ${places.name} = ${`${qBare}市`} then 530
      when ${places.name} = ${`${qBare}县`} then 520
      when ${places.name} = ${`${qBare}区`} then 510
      when lower(coalesce(${places.nameEn}, '')) = ${qLower} then 500
      when ${places.name} like ${prefix} escape '\\' then 300
      when ${places.name} like ${pattern} escape '\\' then 220
      when lower(coalesce(${places.aliases}, '')) like ${patternLower} escape '\\' then 200
      when lower(coalesce(${places.pinyinAbbr}, '')) = ${qLower} then 180
      when lower(coalesce(${places.pinyin}, '')) = ${qLower} then 160
      when ${places.province} = ${q}
        or ${places.province} = ${`${qBare}省`}
        or ${places.city} = ${q}
        or ${places.city} = ${`${qBare}市`}
        or ${places.district} = ${q}
        or ${places.district} = ${`${qBare}市`}
        or ${places.district} = ${`${qBare}县`}
        or ${places.district} = ${`${qBare}区`}
        then 120
      else 40
    end
  )`

  // 「河南」时应抬高河南省内城市，压过外省名称碰巧含「河南」的乡镇/县
  const regionBoost = sql`(
    case
      when length(${qBare}) >= 2 and (
        ${places.province} = ${q}
        or ${places.province} = ${`${qBare}省`}
        or ${places.province} like ${barePrefix} escape '\\'
        or ${places.city} = ${q}
        or ${places.city} = ${`${qBare}市`}
        or ${places.city} like ${barePrefix} escape '\\'
      ) then 250
      else 0
    end
  )`

  const rows = await db
    .select({
      name: places.name,
      latitude: places.latitude,
      longitude: places.longitude,
      country: places.country,
      province: places.province,
      city: places.city,
      district: places.district,
      placeType: places.placeType,
      priority: places.priority,
    })
    .from(places)
    .where(and(eq(places.enabled, true), matchClause))
    .orderBy(
      desc(sql`(${nameScore} + ${typeRank} + ${regionBoost})`),
      desc(places.priority),
      asc(places.id),
    )
    .limit(Math.min(50, Math.max(1, limit)))

  return rows.map((row) => ({
    latitude: row.latitude,
    longitude: row.longitude,
    label: buildLabel(row),
    country: row.country ?? undefined,
    city: row.city ?? row.district ?? undefined,
    placeType: row.placeType ?? undefined,
    province: row.province ?? undefined,
  }))
}

const EARTH_RADIUS_KM = 6371

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

export type LocalReverseHit = PlaceSearchHit & { distanceKm: number }

/**
 * Offline reverse geocode: nearest enabled place within maxDistanceKm.
 * Uses a coarse bbox prefilter then haversine ranking (prefer city/district).
 */
export async function findNearestLocalPlace(
  lat: number,
  lon: number,
  maxDistanceKm = 80,
): Promise<LocalReverseHit | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  // ~1° latitude ≈ 111 km; loosen longitude for high latitudes.
  const latDelta = Math.max(0.3, maxDistanceKm / 111)
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  const lonDelta = Math.max(0.3, maxDistanceKm / (111 * cosLat))

  const db = useDB()
  const places = tables.geocodePlaces
  const typeRank = sql`(
    case coalesce(${places.placeType}, '')
      when 'city' then 600
      when 'district' then 500
      when 'province' then 400
      when 'town' then 300
      when 'landmark' then 200
      when 'poi' then 100
      else 50
    end
  )`

  const rows = await db
    .select({
      name: places.name,
      latitude: places.latitude,
      longitude: places.longitude,
      country: places.country,
      province: places.province,
      city: places.city,
      district: places.district,
      placeType: places.placeType,
      priority: places.priority,
    })
    .from(places)
    .where(
      and(
        eq(places.enabled, true),
        sql`${places.latitude} between ${lat - latDelta} and ${lat + latDelta}`,
        sql`${places.longitude} between ${lon - lonDelta} and ${lon + lonDelta}`,
      ),
    )
    .orderBy(desc(typeRank), desc(places.priority))
    .limit(80)

  let best: LocalReverseHit | null = null
  for (const row of rows) {
    const distanceKm = haversineKm(lat, lon, row.latitude, row.longitude)
    if (distanceKm > maxDistanceKm) continue
    const hit: LocalReverseHit = {
      latitude: row.latitude,
      longitude: row.longitude,
      label: buildLabel(row),
      country: row.country ?? undefined,
      city: row.city ?? row.district ?? row.name,
      placeType: row.placeType ?? undefined,
      province: row.province ?? undefined,
      distanceKm,
    }
    if (
      !best ||
      distanceKm < best.distanceKm - 0.5 ||
      (Math.abs(distanceKm - best.distanceKm) <= 0.5 &&
        (row.placeType === 'city' || row.placeType === 'district') &&
        best.placeType !== 'city' &&
        best.placeType !== 'district')
    ) {
      best = hit
    }
  }
  return best
}
