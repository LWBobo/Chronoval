import { join } from 'node:path'
import { open, stat } from 'node:fs/promises'
import { MAP_PMTILES_DIR, mapPmtilesFilename } from '~~/shared/map-pmtiles'

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

const PMTILES_MAGIC = 'PMTiles'
const ARCHIVE_META_TTL_MS = 60_000
type ArchiveMetadata = {
  filePath: string
  size: number
  mtimeMs: number
  checkedAt: number
}
const archiveMetadata = new Map<string, ArchiveMetadata>()

/** Cache stat and header validation so every tile range does not reopen byte 0. */
export async function readPmtilesArchiveMetadata(fileName: string) {
  const filePath = mapPmtilesPath(fileName)
  const cached = archiveMetadata.get(filePath)
  if (cached && Date.now() - cached.checkedAt < ARCHIVE_META_TTL_MS) {
    return cached
  }

  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || fileStat.size < PMTILES_MAGIC.length) {
    throw new Error(`Map archive not found: ${filePath}`)
  }
  const header = Buffer.alloc(PMTILES_MAGIC.length)
  const handle = await open(filePath, 'r')
  try {
    await handle.read(header, 0, header.length, 0)
  } finally {
    await handle.close()
  }
  if (header.toString() !== PMTILES_MAGIC) {
    throw new TypeError('File is not a PMTiles archive')
  }

  const result = {
    filePath,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    checkedAt: Date.now(),
  }
  archiveMetadata.set(filePath, result)
  return result
}
