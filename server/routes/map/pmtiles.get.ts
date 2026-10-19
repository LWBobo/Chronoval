import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { DEFAULT_PMTILES_FILE } from '~~/shared/map-pmtiles'
import { mapPmtilesPath } from '~~/server/utils/map-pmtiles'

const PMTILES_MAGIC = 'PMTiles'
// A missing Range on the first byte makes the pmtiles client retry
// bytes=0-(size-1). Never answer that with the whole planet archive.
const MAX_SLICE_BYTES = 32 * 1024 * 1024

/**
 * Serve a local PMTiles archive with HTTP range requests.
 * MapLibre's pmtiles protocol reads the header and tiles by byte range;
 * the 129 GiB planet file must never be buffered or streamed in full.
 */
export default defineEventHandler(async (event) => {
  const queryName = getQuery(event).file
  const configured = await settingsManager
    .get<string>('map', 'protomaps.file', DEFAULT_PMTILES_FILE)
    .catch(() => DEFAULT_PMTILES_FILE)
  const requested =
    typeof queryName === 'string' && queryName.trim() ? queryName : configured
  const filePath = mapPmtilesPath(requested)

  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(filePath)
  } catch {
    throw createError({
      statusCode: 404,
      statusMessage: `Map archive not found: ${filePath}`,
    })
  }
  if (!fileStat.isFile() || fileStat.size < PMTILES_MAGIC.length) {
    throw createError({
      statusCode: 404,
      statusMessage: `Map archive not found: ${filePath}`,
    })
  }

  const header = Buffer.alloc(PMTILES_MAGIC.length)
  const handle = await open(filePath, 'r')
  try {
    await handle.read(header, 0, header.length, 0)
  } finally {
    await handle.close()
  }
  if (header.toString() !== PMTILES_MAGIC) {
    throw createError({
      statusCode: 415,
      statusMessage: 'File is not a PMTiles archive',
    })
  }

  const size = fileStat.size
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(event, 'Cache-Control', 'public, max-age=3600')
  setHeader(event, 'ETag', `"${fileStat.mtimeMs}-${size}"`)

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
  return sendStream(event, createReadStream(filePath, { start, end }))
})
