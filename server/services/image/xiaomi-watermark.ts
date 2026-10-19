import sharp from 'sharp'

/**
 * 小米相机把时间水印画进 JPEG 像素，同时在文件尾保存被盖住的原图小块，
 * 再后面常常还有一段动态照片 MP4。
 *
 * 清除时只重编码画面，EXIF / ICC / XMP 段从原图原样搬过来，再删掉水印标记。
 * 动态照片视频按原字节接回文件末尾。任何校验失败都只抛错，不写原路径。
 */

export class WatermarkEditError extends Error {
  readonly code:
    | 'not-watermark'
    | 'align'
    | 'motion-missing'
    | 'decode'
    | 'metadata'

  constructor(
    code:
      | 'not-watermark'
      | 'align'
      | 'motion-missing'
      | 'decode'
      | 'metadata',
    message: string,
  ) {
    super(message)
    this.name = 'WatermarkEditError'
    this.code = code
  }
}

interface XiaomiSubimage {
  offset: number
  length: number
  paddingX: number
  paddingY: number
  rotation: number
}

interface XiaomiWatermarkMeta {
  sub: XiaomiSubimage
  watermark: { offset: number; length: number }
}

const HEADER_SCAN_BYTES = 1024 * 1024
const ALIGN_LIMIT = 12

const unescapeXml = (value: string) =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')

const tagAttrs = (xml: string, tag: string) => {
  const match = new RegExp(`<${tag}\\b([^>/]*)\\/?>`, 'i').exec(xml)
  if (!match?.[1]) return null
  const attrs: Record<string, string> = {}
  for (const item of match[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    const key = item[1]
    const value = item[2]
    if (key && value != null) attrs[key.toLowerCase()] = value
  }
  return attrs
}

const readPositive = (attrs: Record<string, string>, key: string) => {
  const value = Number(attrs[key])
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

export const parseXiaomiWatermark = (
  header: Buffer,
): XiaomiWatermarkMeta | null => {
  const raw = header.toString('latin1')
  if (!raw.includes('timewatermark') || !raw.includes('subimage')) return null
  const xml = unescapeXml(raw)
  const sub = tagAttrs(xml, 'subimage')
  const watermark = tagAttrs(xml, 'timewatermark')
  if (!sub || !watermark) return null

  const offset = readPositive(sub, 'offset')
  const length = readPositive(sub, 'length')
  const paddingX = readPositive(sub, 'paddingx')
  const paddingY = readPositive(sub, 'paddingy')
  const rotation = Number(sub.rotation)
  const wmOffset = readPositive(watermark, 'offset')
  const wmLength = readPositive(watermark, 'length')
  if (
    offset == null ||
    length == null ||
    paddingX == null ||
    paddingY == null ||
    wmOffset == null ||
    wmLength == null ||
    !Number.isInteger(rotation)
  ) {
    return null
  }
  if (offset <= 0 || length <= 0 || wmOffset <= 0 || wmLength <= 0) return null

  return {
    sub: { offset, length, paddingX, paddingY, rotation },
    watermark: { offset: wmOffset, length: wmLength },
  }
}

const readMotion = (header: Buffer) => {
  const text = unescapeXml(header.toString('latin1'))
  const flag = /(?:[\w-]+:)?MicroVideo="([^"]+)"/i.exec(text)
  const offset = /(?:[\w-]+:)?MicroVideoOffset="(\d+)"/i.exec(text)
  const enabled = flag
    ? ['1', 'true', 'yes'].includes(flag[1]!.trim().toLowerCase())
    : false
  return {
    enabled,
    offset: offset ? Number(offset[1]) : null,
  }
}

const hasFtyp = (data: Buffer, start: number) => {
  if (start <= 0 || start >= data.length - 8) return false
  return data.subarray(start, Math.min(data.length, start + 32)).includes(Buffer.from('ftyp'))
}

/** 动态照片视频在文件尾。声明了视频却找不到时抛错，避免清掉水印时把视频丢掉。 */
export const locateMotionVideo = (data: Buffer): number | null => {
  const header = data.subarray(0, Math.min(data.length, HEADER_SCAN_BYTES))
  const motion = readMotion(header)
  const expects = motion.enabled || motion.offset != null
  if (!expects) return null

  if (motion.offset != null && hasFtyp(data, data.length - motion.offset)) {
    return data.length - motion.offset
  }

  const windowStart = Math.max(0, data.length - 32 * 1024 * 1024)
  let cursor = data.indexOf(Buffer.from('ftyp'), windowStart)
  while (cursor !== -1) {
    const start = cursor - 4
    if (hasFtyp(data, start)) return start
    cursor = data.indexOf(Buffer.from('ftyp'), cursor + 1)
  }

  throw new WatermarkEditError(
    'motion-missing',
    '文件声明了动态照片视频，但没有找到，已停止修改',
  )
}

const markerLength = (buf: Buffer, offset: number) => buf.readUInt16BE(offset + 2)

const walkMarkers = (
  jpeg: Buffer,
  onSegment: (marker: number, offset: number, end: number) => boolean | void,
) => {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new WatermarkEditError('decode', '不是 JPEG 文件')
  }
  let offset = 2
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      throw new WatermarkEditError('decode', 'JPEG 标记损坏')
    }
    while (offset < jpeg.length && jpeg[offset] === 0xff) offset += 1
    offset -= 1
    const marker = jpeg[offset + 1]
    if (marker == null) break
    if (marker === 0xda || marker === 0xd9) {
      onSegment(marker, offset, jpeg.length)
      return
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = markerLength(jpeg, offset)
    const end = offset + 2 + length
    if (length < 2 || end > jpeg.length) {
      throw new WatermarkEditError('decode', 'JPEG 段长度越界')
    }
    const stop = onSegment(marker, offset, end)
    if (stop) return
    offset = end
  }
  throw new WatermarkEditError('decode', 'JPEG 结构不完整')
}

const imagePayload = (jpeg: Buffer) => {
  let payload: Buffer | null = null
  walkMarkers(jpeg, (marker, offset) => {
    if (
      marker === 0xdb ||
      marker === 0xc0 ||
      marker === 0xc2 ||
      marker === 0xc4
    ) {
      payload = jpeg.subarray(offset)
      return true
    }
    return false
  })
  if (!payload) {
    throw new WatermarkEditError('decode', '重编码后的图像缺少量化表')
  }
  return payload
}

const originalAppSegments = (jpeg: Buffer) => {
  const parts: Buffer[] = []
  walkMarkers(jpeg, (marker, offset, end) => {
    if (marker === 0xda) return true
    const keep = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe
    if (keep) parts.push(jpeg.subarray(offset, end))
    return false
  })
  return parts
}

const rewriteSegment = (segment: Buffer, nextPayload: Buffer) => {
  if (nextPayload.length + 2 > 0xffff) {
    throw new WatermarkEditError('metadata', '元数据段超出 JPEG 长度限制')
  }
  const out = Buffer.alloc(4 + nextPayload.length)
  out[0] = segment[0]!
  out[1] = segment[1]!
  out.writeUInt16BE(nextPayload.length + 2, 2)
  nextPayload.copy(out, 4)
  return out
}

const stripWatermarkTags = (text: string, motionBytes: number | null) => {
  let next = text
    .replace(/&lt;subimage\b[\s\S]*?\/&gt;/gi, '')
    .replace(/&lt;timewatermark\b[\s\S]*?\/&gt;/gi, '')
    .replace(/<subimage\b[\s\S]*?\/>/gi, '')
    .replace(/<timewatermark\b[\s\S]*?\/>/gi, '')
  if (motionBytes != null) {
    next = next.replace(
      /MicroVideoOffset="\d+"/gi,
      `MicroVideoOffset="${motionBytes}"`,
    )
  }
  return next
}

const rewriteApps = (apps: Buffer[], motionBytes: number | null) => {
  let touched = false
  const next = apps.map((segment) => {
    const payload = segment.subarray(4)
    const hasWatermark = payload.includes(Buffer.from('timewatermark'))
    const hasMotionOffset = payload.includes(Buffer.from('MicroVideoOffset'))
    if (!hasWatermark && !(motionBytes != null && hasMotionOffset)) return segment
    const text = payload.toString('latin1')
    const updated = stripWatermarkTags(text, motionBytes)
    if (updated === text) return segment
    touched = true
    return rewriteSegment(segment, Buffer.from(updated, 'latin1'))
  })
  if (!touched) {
    throw new WatermarkEditError('metadata', '没能从元数据里去掉水印标记')
  }
  if (Buffer.concat(next).includes(Buffer.from('timewatermark'))) {
    throw new WatermarkEditError('metadata', '水印标记仍留在元数据里')
  }
  return next
}

/** 小米用 -1 表示补丁已经和 JPEG 像素同向，不需要再旋转。 */
const normalizeRotation = (rotation: number) =>
  rotation === -1 ? 0 : ((rotation % 360) + 360) % 360

const placement = (
  rotation: number,
  imageWidth: number,
  patchWidth: number,
  paddingX: number,
  paddingY: number,
) => {
  const turn = normalizeRotation(rotation)
  if (turn === 0) return { x: paddingX, y: paddingY }
  if (turn === 90) return { x: imageWidth - patchWidth - paddingY, y: paddingX }
  if (turn === 180) {
    return null
  }
  if (turn === 270) return null
  return null
}

const rotateRaw = (
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  rotation: number,
) => {
  const turn = normalizeRotation(rotation)
  if (turn === 0) return { data, width, height }
  const out = Buffer.alloc(data.length)
  const write = (x: number, y: number, nx: number, ny: number, nextWidth: number) => {
    const source = (y * width + x) * channels
    const target = (ny * nextWidth + nx) * channels
    data.copy(out, target, source, source + channels)
  }
  if (turn === 90) {
    const nextWidth = height
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) write(x, y, height - 1 - y, x, nextWidth)
    }
    return { data: out, width: nextWidth, height: width }
  }
  if (turn === 180) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        write(x, y, width - 1 - x, height - 1 - y, width)
      }
    }
    return { data: out, width, height }
  }
  if (turn === 270) {
    const nextWidth = height
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) write(x, y, y, width - 1 - x, nextWidth)
    }
    return { data: out, width: nextWidth, height: width }
  }
  throw new WatermarkEditError('align', `不支持的水印旋转角度 ${rotation}`)
}

const borderMismatch = (
  image: Buffer,
  imageWidth: number,
  patch: Buffer,
  patchWidth: number,
  patchHeight: number,
  channels: number,
  left: number,
  top: number,
) => {
  const border = 4
  let sum = 0
  let count = 0
  for (let y = 0; y < patchHeight; y++) {
    for (let x = 0; x < patchWidth; x++) {
      const edge =
        y < border ||
        y >= patchHeight - border ||
        x < border ||
        x >= patchWidth - border
      if (!edge) continue
      const imageIndex = ((top + y) * imageWidth + (left + x)) * channels
      const patchIndex = (y * patchWidth + x) * channels
      for (let channel = 0; channel < 3; channel++) {
        sum += Math.abs(
          image[imageIndex + channel]! - patch[patchIndex + channel]!,
        )
        count++
      }
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count
}

const decodeRaw = async (input: Buffer) => {
  try {
    const decoded = await sharp(input, { failOn: 'none' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (decoded.info.channels < 3) {
      throw new WatermarkEditError('decode', '图像通道数不足')
    }
    return decoded
  } catch (error) {
    if (error instanceof WatermarkEditError) throw error
    throw new WatermarkEditError(
      'decode',
      error instanceof Error ? error.message : '图像解码失败',
    )
  }
}

/**
 * 生成去掉小米时间水印后的完整文件字节。不碰磁盘上的原文件。
 */
export const buildCleanXiaomiJpeg = async (original: Buffer) => {
  const header = original.subarray(0, Math.min(original.length, HEADER_SCAN_BYTES))
  const meta = parseXiaomiWatermark(header)
  if (!meta) {
    throw new WatermarkEditError('not-watermark', '没有小米时间水印数据')
  }

  const subStart = original.length - meta.sub.offset
  const watermarkStart = original.length - meta.watermark.offset
  if (
    subStart < 4 ||
    watermarkStart < 4 ||
    subStart + meta.sub.length > original.length ||
    watermarkStart + meta.watermark.length > original.length
  ) {
    throw new WatermarkEditError('decode', '水印数据偏移超出文件')
  }

  const trailerStart = Math.min(subStart, watermarkStart)
  if (
    original[trailerStart - 2] !== 0xff ||
    original[trailerStart - 1] !== 0xd9
  ) {
    throw new WatermarkEditError('decode', '主图结束位置无法确认')
  }

  const motionStart = locateMotionVideo(original)
  const blobEnd = Math.max(
    subStart + meta.sub.length,
    watermarkStart + meta.watermark.length,
  )
  if (motionStart != null && motionStart < blobEnd) {
    throw new WatermarkEditError('motion-missing', '动态照片视频和水印数据重叠')
  }

  const mainJpeg = original.subarray(0, trailerStart)
  const subimage = original.subarray(subStart, subStart + meta.sub.length)
  const base = await decodeRaw(mainJpeg)
  const patch = await decodeRaw(subimage)
  const channels = Math.min(base.info.channels, patch.info.channels)
  const rotated = rotateRaw(
    patch.data,
    patch.info.width,
    patch.info.height,
    patch.info.channels,
    meta.sub.rotation,
  )
  const spot = placement(
    meta.sub.rotation,
    base.info.width,
    rotated.width,
    meta.sub.paddingX,
    meta.sub.paddingY,
  )
  if (
    !spot ||
    spot.x < 0 ||
    spot.y < 0 ||
    spot.x + rotated.width > base.info.width ||
    spot.y + rotated.height > base.info.height
  ) {
    throw new WatermarkEditError('align', '水印位置超出画面，已停止修改')
  }
  if (base.info.channels !== patch.info.channels) {
    throw new WatermarkEditError('decode', '原图和水印补丁的通道不一致')
  }

  const mismatch = borderMismatch(
    base.data,
    base.info.width,
    rotated.data,
    rotated.width,
    rotated.height,
    channels,
    spot.x,
    spot.y,
  )
  if (mismatch > ALIGN_LIMIT) {
    throw new WatermarkEditError(
      'align',
      '水印补丁和画面对不齐，已停止修改',
    )
  }

  let pixelJpeg: Buffer
  try {
    pixelJpeg = await sharp(mainJpeg, { failOn: 'none' })
      .composite([
        {
          input: rotated.data,
          raw: {
            width: rotated.width,
            height: rotated.height,
            channels: patch.info.channels as 3 | 4,
          },
          left: spot.x,
          top: spot.y,
        },
      ])
      .jpeg({
        quality: 100,
        chromaSubsampling: '4:4:4',
        mozjpeg: true,
      })
      .toBuffer()
  } catch (error) {
    throw new WatermarkEditError(
      'decode',
      error instanceof Error ? error.message : '重编码失败',
    )
  }

  const motion = motionStart == null ? null : original.subarray(motionStart)
  const apps = rewriteApps(originalAppSegments(mainJpeg), motion?.length ?? null)
  const output = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...apps,
    imagePayload(pixelJpeg),
    ...(motion ? [motion] : []),
  ])

  if (
    output[output.length - (motion?.length ?? 0) - 2] !== 0xff ||
    output[output.length - (motion?.length ?? 0) - 1] !== 0xd9
  ) {
    throw new WatermarkEditError('decode', '输出的 JPEG 不完整')
  }
  if (motion && !hasFtyp(output, output.length - motion.length)) {
    throw new WatermarkEditError('motion-missing', '动态照片视频没有接回文件末尾')
  }

  try {
    const checked = await sharp(output, { failOn: 'none' }).metadata()
    if (!checked.width || !checked.height) {
      throw new WatermarkEditError('decode', '输出图像无法读取')
    }
  } catch (error) {
    if (error instanceof WatermarkEditError) throw error
    throw new WatermarkEditError('decode', '输出图像无法读取')
  }

  return output
}
