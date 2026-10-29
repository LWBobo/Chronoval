import { settingsManager } from '~~/server/services/settings/settingsManager'
import { DEFAULT_PMTILES_FILE } from '~~/shared/map-pmtiles'
import { readPmtilesArchiveMetadata } from '~~/server/utils/map-pmtiles'
import {
  resolvePmtilesRange,
  streamPmtilesRange,
  touchPmtilesCacheActivity,
} from '~~/server/utils/pmtiles-range-cache'

// A missing Range on the first byte makes the pmtiles client retry
// bytes=0-(size-1). Never answer that with the whole planet archive.
const MAX_SLICE_BYTES = 32 * 1024 * 1024

/**
 * Serve a local PMTiles archive with HTTP range requests.
 * MapLibre's pmtiles protocol reads the header and tiles by byte range;
 * the 129 GiB planet file must never be buffered or streamed in full.
 *
 * Small ranges go through an in-process MEM + optional DISK cache so
 * timeline hops re-hit warm slices instead of re-reading the archive.
 */
export default defineEventHandler(async (event) => {
  const queryName = getQuery(event).file
  const requested =
    typeof queryName === 'string' && queryName.trim()
      ? queryName
      : await settingsManager
          .get<string>('map', 'protomaps.file', DEFAULT_PMTILES_FILE)
          .catch(() => DEFAULT_PMTILES_FILE)

  let archive: Awaited<ReturnType<typeof readPmtilesArchiveMetadata>>
  try {
    archive = await readPmtilesArchiveMetadata(requested)
  } catch (error) {
    throw createError({
      statusCode: error instanceof TypeError ? 415 : 404,
      statusMessage:
        error instanceof Error ? error.message : 'Map archive not found',
    })
  }

  const { filePath, size, mtimeMs } = archive
  touchPmtilesCacheActivity()
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Content-Type', 'application/octet-stream')
  // Nginx Proxy Manager respects this header and forwards small Range slices
  // immediately instead of buffering them to disk before the browser sees them.
  setHeader(event, 'X-Accel-Buffering', 'no')
  // Filename is versioned (e.g. 20261018.pmtiles). Long cache lets the browser
  // reuse range responses across timeline hops instead of re-hitting disk.
  setHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  setHeader(event, 'ETag', `"${mtimeMs}-${size}"`)

  const range = getRequestHeader(event, 'range')
  if (!range) {
    setResponseStatus(event, 416)
    setHeader(event, 'Content-Range', `bytes */${size}`)
    return ''
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (!match) {
    setResponseStatus(event, 416)
    setHeader(event, 'Content-Range', `bytes */${size}`)
    return ''
  }

  const start = Number(match[1])
  // An omitted end means "through the end of the file". Cap that so a bare
  // request cannot stream the whole planet archive.
  let end = match[2]
    ? Number(match[2])
    : Math.min(start + 8 * 1024 * 1024 - 1, size - 1)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    setResponseStatus(event, 416)
    setHeader(event, 'Content-Range', `bytes */${size}`)
    return ''
  }
  if (end >= size) end = size - 1
  if (end - start + 1 > MAX_SLICE_BYTES) {
    setResponseStatus(event, 416)
    setHeader(event, 'Content-Range', `bytes */${size}`)
    return ''
  }

  setResponseStatus(event, 206)
  setHeader(event, 'Content-Range', `bytes ${start}-${end}/${size}`)
  setHeader(event, 'Content-Length', String(end - start + 1))

  const cached = await resolvePmtilesRange({
    fileName: requested,
    filePath,
    mtimeMs,
    size,
    start,
    end,
  })
  if (cached) {
    setHeader(event, 'X-PMTiles-Cache', cached.cache)
    return cached.body
  }

  setHeader(event, 'X-PMTiles-Cache', 'BYPASS')
  return sendStream(event, streamPmtilesRange(filePath, start, end))
})
