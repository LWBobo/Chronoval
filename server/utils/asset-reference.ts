export type AssetKind = 'original' | 'live'

/** Stable, filename-free URL identifiers. Access is always checked separately. */
export function photoAssetUrl(photoId: string, kind: AssetKind): string {
  const prefix = kind === 'original' ? '0' : '1'
  return `/api/assets/${prefix}${Buffer.from(photoId, 'utf8').toString('hex')}`
}

export function parsePhotoAssetId(
  value: string,
): { photoId: string; kind: AssetKind } | null {
  if (!/^[01](?:[a-f0-9]{2}){1,1024}$/.test(value)) return null
  const encoded = value.slice(1)
  const photoId = Buffer.from(encoded, 'hex').toString('utf8')
  // Reject malformed UTF-8 and alternate encodings of the same identifier.
  if (!photoId || Buffer.from(photoId, 'utf8').toString('hex') !== encoded)
    return null
  return { photoId, kind: value[0] === '0' ? 'original' : 'live' }
}

/** Only replace photo playback links; leave stills, thumbnails and cached rows intact. */
export function withPhotoAssetUrls<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let changed = false
    const result = value.map((item) => {
      const next = withPhotoAssetUrls(item)
      if (next !== item) changed = true
      return next
    })
    return (changed ? result : value) as T
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const row = value as Record<string, unknown>
  if (
    typeof row.id === 'string' &&
    (typeof row.originalUrl === 'string' ||
      typeof row.livePhotoVideoUrl === 'string')
  ) {
    let result = row
    if (row.type === 'video' && row.originalUrl) {
      const url = photoAssetUrl(row.id, 'original')
      if (url !== row.originalUrl) result = { ...result, originalUrl: url }
    }
    if (row.isLivePhoto && row.livePhotoVideoUrl) {
      const url = photoAssetUrl(row.id, 'live')
      if (url !== row.livePhotoVideoUrl)
        result = { ...result, livePhotoVideoUrl: url }
    }
    return result as T
  }
  let result = row
  for (const [key, item] of Object.entries(row)) {
    const next = withPhotoAssetUrls(item)
    if (next !== item) {
      if (result === row) result = { ...row }
      result[key] = next
    }
  }
  return result as T
}
