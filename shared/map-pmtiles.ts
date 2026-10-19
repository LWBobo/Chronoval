/** Container directory that holds local Protomaps archives. */
export const MAP_PMTILES_DIR = '/app/map'

export const DEFAULT_PMTILES_FILE = '20261018.pmtiles'

/**
 * Accept only a bare archive name. Rejects directories and parent segments
 * so the tile route cannot be pointed outside `/app/map`.
 */
export function mapPmtilesFilename(name: string | null | undefined): string {
  const raw = (name ?? '').trim() || DEFAULT_PMTILES_FILE
  if (
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.includes('..') ||
    raw === '.' ||
    !raw.endsWith('.pmtiles')
  ) {
    throw new Error('Map archive must be a .pmtiles file inside /app/map')
  }
  return raw
}
