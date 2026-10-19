import { join } from 'node:path'
import {
  MAP_PMTILES_DIR,
  mapPmtilesFilename,
} from '~~/shared/map-pmtiles'

export { MAP_PMTILES_DIR, mapPmtilesFilename }

export function mapPmtilesPath(name: string | null | undefined): string {
  try {
    return join(MAP_PMTILES_DIR, mapPmtilesFilename(name))
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage:
        error instanceof Error
          ? error.message
          : 'Map archive must be a .pmtiles file inside /app/map',
    })
  }
}
