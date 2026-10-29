import { settingsManager } from '~~/server/services/settings/settingsManager'
import { DEFAULT_PMTILES_FILE } from '~~/shared/map-pmtiles'
import { readPmtilesArchiveMetadata } from '~~/server/utils/map-pmtiles'
import {
  touchPmtilesCacheActivity,
  warmPmtilesHeader,
} from '~~/server/utils/pmtiles-range-cache'

/**
 * Lightweight heartbeat when a map page mounts.
 * Refreshes idle timer and opportunistically warms the archive header.
 */
export default defineEventHandler(async () => {
  touchPmtilesCacheActivity()

  try {
    const configured = await settingsManager
      .get<string>('map', 'protomaps.file', DEFAULT_PMTILES_FILE)
      .catch(() => DEFAULT_PMTILES_FILE)
    const archive = await readPmtilesArchiveMetadata(configured)
    void warmPmtilesHeader({
      fileName: configured,
      filePath: archive.filePath,
      mtimeMs: archive.mtimeMs,
      size: archive.size,
    })
  } catch {
    // Archive may be missing in local/dev without a mounted map volume.
  }

  return { ok: true }
})
