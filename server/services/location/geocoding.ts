import { withRetry, RetryPresets } from '../../utils/retry'
import { settingsManager } from '../settings/settingsManager'
import { findNearestLocalPlace, searchLocalPlaces } from './localPlaces'

export interface LocationInfo {
  latitude: number
  longitude: number
  country?: string
  city?: string
  locationName?: string
}

export interface PlaceSearchHit {
  latitude: number
  longitude: number
  label: string
  country?: string
  city?: string
  province?: string
  /** 本地库行政层级：province | city | district | town | landmark | poi | other */
  placeType?: string
}

export interface GeocodingProvider {
  reverseGeocode(lat: number, lon: number): Promise<LocationInfo | null>
  searchPlaces(query: string, limit?: number): Promise<PlaceSearchHit[]>
}

/**
 * Mapbox 地理编码提供者
 * 高精度商业地理编码服务，支持全球范围和多语言
 */
export class MapboxGeocodingProvider implements GeocodingProvider {
  private accessToken: string
  private readonly baseUrl = 'https://api.mapbox.com'
  private lastRequestTime = 0
  private readonly rateLimitMs = 100 // Mapbox 默认速率限制为 1000/分钟，约60ms间隔

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  async reverseGeocode(lat: number, lon: number): Promise<LocationInfo | null> {
    try {
      return await withRetry(
        async () => {
          // 应用速率限制
          await this.applyRateLimit()

          // 获取设置的地理编码语言，默认 'en'
          const language =
            (await settingsManager.get<string>('location', 'language')) || 'en'

          const url = new URL('/search/geocode/v6/reverse', this.baseUrl)
          url.searchParams.set('access_token', this.accessToken)
          url.searchParams.set('longitude', lon.toString())
          url.searchParams.set('latitude', lat.toString())
          url.searchParams.set('types', 'address,place,district,region,country')

          // 映射 Mapbox 首选语言格式
          let mapboxLang = language
          if (language === 'zh-CN') {
            mapboxLang = 'zh-Hans'
          } else if (language === 'zh-TW') {
            mapboxLang = 'zh-Hant'
          }
          url.searchParams.set('language', mapboxLang)

          logger.location.info(`Mapbox API URL: ${url.toString()}`)

          const response = await fetch(url.toString())

          if (!response.ok) {
            throw new Error(
              `Mapbox API error: ${response.status} ${response.statusText}`,
            )
          }

          const data = await response.json()

          if (!data || !data.features || data.features.length === 0) {
            logger.location.warn('Mapbox API returned no features')
            return null
          }

          // 取第一个最相关的结果
          const feature = data.features[0]
          const properties = feature.properties || {}
          const context = properties.context || {}

          // 提取国家信息
          const country = context.country?.name

          // 提取城市信息（优先级：locality > place > locality > district > region）
          const city =
            context.locality?.name ||
            context.place?.name ||
            context.locality?.name ||
            context.district?.name ||
            context.region?.name

          // 构建位置名称
          const locationName = properties.place_formatted || properties.name

          logger.location.success(
            `Successfully geocoded location: ${city}, ${country}`,
          )
          return {
            latitude: lat,
            longitude: lon,
            country,
            city,
            locationName,
          }
        },
        {
          ...RetryPresets.network,
          timeout: 10000,
          delayStrategy: 'exponential',
        },
        logger.location,
      )
    } catch (error) {
      logger.location.error(
        'Mapbox reverse geocoding failed after all retries:',
        error,
      )
      return null
    }
  }

  async searchPlaces(query: string, limit = 8): Promise<PlaceSearchHit[]> {
    const q = query.trim()
    if (!q) return []
    try {
      return await withRetry(
        async () => {
          await this.applyRateLimit()
          const language =
            (await settingsManager.get<string>('location', 'language')) || 'en'
          let mapboxLang = language
          if (language === 'zh-CN') mapboxLang = 'zh-Hans'
          else if (language === 'zh-TW') mapboxLang = 'zh-Hant'

          const url = new URL('/search/geocode/v6/forward', this.baseUrl)
          url.searchParams.set('access_token', this.accessToken)
          url.searchParams.set('q', q)
          url.searchParams.set('limit', String(Math.min(10, Math.max(1, limit))))
          url.searchParams.set('language', mapboxLang)
          url.searchParams.set('types', 'address,place,district,region,country,locality,neighborhood')

          const response = await fetch(url.toString())
          if (!response.ok) {
            throw new Error(
              `Mapbox API error: ${response.status} ${response.statusText}`,
            )
          }
          const data = await response.json()
          const features = Array.isArray(data?.features) ? data.features : []
          return features
            .map((feature: any): PlaceSearchHit | null => {
              const coords = feature?.geometry?.coordinates
              if (!Array.isArray(coords) || coords.length < 2) return null
              const longitude = Number(coords[0])
              const latitude = Number(coords[1])
              if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return null
              }
              const properties = feature.properties || {}
              const context = properties.context || {}
              return {
                latitude,
                longitude,
                label:
                  properties.full_address ||
                  properties.place_formatted ||
                  properties.name ||
                  q,
                country: context.country?.name,
                city:
                  context.locality?.name ||
                  context.place?.name ||
                  context.district?.name ||
                  context.region?.name,
              }
            })
            .filter((hit: PlaceSearchHit | null): hit is PlaceSearchHit => Boolean(hit))
        },
        {
          ...RetryPresets.network,
          timeout: 10000,
          delayStrategy: 'exponential',
        },
        logger.location,
      )
    } catch (error) {
      logger.location.error('Mapbox place search failed after all retries:', error)
      return []
    }
  }

  private async applyRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < this.rateLimitMs) {
      const delay = this.rateLimitMs - timeSinceLastRequest
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    this.lastRequestTime = Date.now()
  }
}

/**
 * OpenStreetMap Nominatim API 地理编码提供者
 * 免费的地理编码服务，适合开发和小规模使用
 */
export class NominatimGeocodingProvider implements GeocodingProvider {
  private readonly baseUrl: string
  private readonly userAgent = 'chronoframe/1.0'
  private lastRequestTime = 0
  private readonly rateLimitMs = 1000 // Nominatim 要求至少1秒间隔

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || 'https://nominatim.openstreetmap.org'
  }

  async reverseGeocode(lat: number, lon: number): Promise<LocationInfo | null> {
    try {
      return await withRetry(
        async () => {
          // 应用速率限制
          await this.applyRateLimit()

          // 获取设置的地理编码语言，默认 'en'
          const language =
            (await settingsManager.get<string>('location', 'language')) || 'en'

          const url = new URL('/reverse', this.baseUrl)
          url.searchParams.set('lat', lat.toString())
          url.searchParams.set('lon', lon.toString())
          url.searchParams.set('format', 'json')
          url.searchParams.set('addressdetails', '1')
          url.searchParams.set('accept-language', `${language},en`)

          const response = await fetch(url.toString(), {
            headers: {
              'User-Agent': this.userAgent,
            },
          })

          if (!response.ok) {
            throw new Error(
              `Nominatim API error: ${response.status} ${response.statusText}`,
            )
          }

          const data = await response.json()

          if (!data || data.error) {
            throw new Error(`Nominatim API returned error: ${data?.error}`)
          }

          const address = data.address || {}

          // 提取国家信息
          const country = address.country || address.country_code?.toUpperCase()

          // 提取城市信息（优先级：district > city > town > county > state > village > hamlet）
          // 适配中国行政区划
          const city =
            address.district ||
            address.city ||
            address.town ||
            address.county ||
            address.state ||
            address.village ||
            address.hamlet

          // 构建位置名称
          const locationName = data.display_name

          return {
            latitude: lat,
            longitude: lon,
            country,
            city,
            locationName,
          }
        },
        {
          // Keep short so air-gapped / intranet deploys fail fast and fall back to local places.
          maxAttempts: 1,
          baseDelay: 0,
          timeout: 5000,
          delayStrategy: 'linear' as const,
        },
        logger.location,
      )
    } catch (error) {
      logger.location.error(
        'Nominatim reverse geocoding failed after all retries:',
        error,
      )
      return null
    }
  }

  async searchPlaces(query: string, limit = 8): Promise<PlaceSearchHit[]> {
    const q = query.trim()
    if (!q) return []
    try {
      return await withRetry(
        async () => {
          await this.applyRateLimit()
          const language =
            (await settingsManager.get<string>('location', 'language')) || 'en'
          const url = new URL('/search', this.baseUrl)
          url.searchParams.set('q', q)
          url.searchParams.set('format', 'json')
          url.searchParams.set('addressdetails', '1')
          url.searchParams.set(
            'limit',
            String(Math.min(10, Math.max(1, limit))),
          )
          url.searchParams.set('accept-language', `${language},en`)

          const response = await fetch(url.toString(), {
            headers: { 'User-Agent': this.userAgent },
          })
          if (!response.ok) {
            throw new Error(
              `Nominatim API error: ${response.status} ${response.statusText}`,
            )
          }
          const data = await response.json()
          if (!Array.isArray(data)) return []
          return data
            .map((item: any): PlaceSearchHit | null => {
              const latitude = Number(item.lat)
              const longitude = Number(item.lon)
              if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return null
              }
              const address = item.address || {}
              return {
                latitude,
                longitude,
                label: item.display_name || q,
                country: address.country || address.country_code?.toUpperCase(),
                city:
                  address.district ||
                  address.city ||
                  address.town ||
                  address.county ||
                  address.state ||
                  address.village ||
                  address.hamlet,
              }
            })
            .filter((hit: PlaceSearchHit | null): hit is PlaceSearchHit => Boolean(hit))
        },
        {
          ...RetryPresets.network,
          timeout: 15000,
          delayStrategy: 'linear',
        },
        logger.location,
      )
    } catch (error) {
      logger.location.error(
        'Nominatim place search failed after all retries:',
        error,
      )
      return []
    }
  }

  private async applyRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < this.rateLimitMs) {
      const delay = this.rateLimitMs - timeSinceLastRequest
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    this.lastRequestTime = Date.now()
  }
}

/**
 * 创建地理编码提供者实例
 * @description 优先使用 Mapbox，如果没有配置则回退到 Nominatim
 */
async function createGeocodingProvider(): Promise<GeocodingProvider> {
  // const mapboxToken = useRuntimeConfig().mapbox?.accessToken
  const mapboxToken = await settingsManager.get<string>(
    'location',
    'mapbox.token',
  )

  if (mapboxToken) {
    return new MapboxGeocodingProvider(mapboxToken)
  }

  // 回退到 Nominatim 提供者
  return new NominatimGeocodingProvider(
    (await settingsManager.get<string>('location', 'nominatim.baseUrl')) ||
      undefined,
  )
}

/**
 * 按地名正向搜索，供编辑照片时选点。
 * 本地 geocode_places 有命中时只返回本地结果（含多省同名列表）；
 * 本地无结果再回退 Mapbox / Nominatim。
 */
export async function searchPlacesByName(
  query: string,
  limit = 20,
): Promise<PlaceSearchHit[]> {
  const q = query.trim()
  if (!q) return []

  const capped = Math.min(50, Math.max(1, limit))
  const local = await searchLocalPlaces(q, capped)
  if (local.length > 0) return local.slice(0, capped)

  try {
    const provider = await createGeocodingProvider()
    const remote = await Promise.race([
      provider.searchPlaces(q, capped),
      new Promise<PlaceSearchHit[]>((resolve) => {
        setTimeout(() => resolve([]), 5000)
      }),
    ])
    return remote.slice(0, capped)
  } catch (error) {
    logger.location.warn(
      'Remote place search failed; returning empty results:',
      error,
    )
    return []
  }
}

function locationFromLocalHit(
  lat: number,
  lon: number,
  hit: NonNullable<Awaited<ReturnType<typeof findNearestLocalPlace>>>,
): LocationInfo {
  return {
    latitude: lat,
    longitude: lon,
    country: hit.country,
    city: hit.city,
    locationName: hit.label,
  }
}

export async function extractLocationFromGPS(
  gpsLatitude?: number,
  gpsLongitude?: number,
  provider?: GeocodingProvider,
): Promise<LocationInfo | null> {
  if (!gpsLatitude || !gpsLongitude) {
    return null
  }

  // 验证坐标范围
  if (Math.abs(gpsLatitude) > 90 || Math.abs(gpsLongitude) > 180) {
    logger.location.warn(
      `Invalid GPS coordinates: ${gpsLatitude}, ${gpsLongitude}`,
    )
    return null
  }

  logger.location.info(
    `Reverse geocoding coordinates: ${gpsLatitude}, ${gpsLongitude}`,
  )

  // Always resolve a local candidate first so intranet / air-gapped uploads
  // never depend on Nominatim or Mapbox being reachable.
  const localHit = await findNearestLocalPlace(gpsLatitude, gpsLongitude)
  const localInfo = localHit
    ? locationFromLocalHit(gpsLatitude, gpsLongitude, localHit)
    : null

  try {
    const geocodingProvider = provider || (await createGeocodingProvider())
    const remote = await Promise.race([
      geocodingProvider.reverseGeocode(gpsLatitude, gpsLongitude),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 6000)
      }),
    ])

    if (remote) {
      logger.location.success(
        `Location found (remote): ${remote.city}, ${remote.country}`,
      )
      return remote
    }
  } catch (error) {
    logger.location.warn(
      'Remote reverse geocode unavailable; using local places if any:',
      error,
    )
  }

  if (localInfo) {
    logger.location.success(
      `Location found (local ${localHit!.distanceKm.toFixed(1)}km): ${localInfo.city}, ${localInfo.country}`,
    )
    return localInfo
  }

  logger.location.warn('No location found for coordinates')
  return null
}

/**
 * 解析EXIF GPS数据为十进制度数
 */
export function parseGPSCoordinates(exifData: any): {
  latitude?: number
  longitude?: number
} {
  try {
    let latitude: number | undefined
    let longitude: number | undefined

    // 尝试从GPSLatitude和GPSLongitude获取
    if (exifData.GPSLatitude && exifData.GPSLongitude) {
      latitude = parseFloat(exifData.GPSLatitude.toString())
      longitude = parseFloat(exifData.GPSLongitude.toString())
    }

    // 如果上面的方法失败，尝试从GPSCoordinates获取
    if ((!latitude || !longitude) && exifData.GPSCoordinates) {
      const coords = exifData.GPSCoordinates.toString()
      const match = coords.match(/([-+]?\d+\.?\d*)[°,\s]+([-+]?\d+\.?\d*)/)
      if (match) {
        latitude = parseFloat(match[1])
        longitude = parseFloat(match[2])
      }
    }

    // 应用GPS参考（南纬为负，西经为负）
    if (latitude && exifData.GPSLatitudeRef === 'S') {
      latitude = -Math.abs(latitude)
    }
    if (longitude && exifData.GPSLongitudeRef === 'W') {
      longitude = -Math.abs(longitude)
    }

    return { latitude, longitude }
  } catch (error) {
    logger.location.error('Failed to parse GPS coordinates:', error)
    return {}
  }
}
