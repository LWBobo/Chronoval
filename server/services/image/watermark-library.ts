import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAllScalableMounts } from '../scan-library/manager'
import { libraryScanner } from '../library/scanner'
import {
  buildCleanXiaomiJpeg,
  parseXiaomiWatermark,
  WatermarkEditError,
} from './xiaomi-watermark'

const log = () => logger.dynamic('watermark')

const HEADER_BYTES = 256 * 1024
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg'])
const SKIP_DIRS = new Set(['.thumbnails', 'thumbnails', '.thumb', '.thumbs'])

const BRAND_MARKERS: { brand: string; markers: string[] }[] = [
  { brand: 'xiaomi', markers: ['xiaomi', 'redmi', 'poco'] },
  { brand: 'apple', markers: ['apple', 'iphone'] },
  { brand: 'vivo', markers: ['vivo', 'iqoo'] },
  { brand: 'oppo', markers: ['oppo', 'oneplus', 'realme'] },
  { brand: 'huawei', markers: ['huawei'] },
  { brand: 'honor', markers: ['honor'] },
  { brand: 'samsung', markers: ['samsung'] },
]

/** 从文件头里的相机厂商判断品牌。认不出时按已识别的水印格式回退。 */
const brandOf = (header: Buffer, fallback: string) => {
  const text = header.toString('latin1').toLowerCase()
  for (const item of BRAND_MARKERS) {
    if (item.markers.some((marker) => text.includes(marker))) return item.brand
  }
  return fallback
}

export interface WatermarkHit {
  mount: string
  mountName: string
  relPath: string
  fileName: string
  size: number
  mtime: string
  brand: string
}

export interface WatermarkScanResult {
  mounts: number
  scanned: number
  unavailable: string[]
  items: WatermarkHit[]
}

export interface WatermarkRemoveResult {
  mount: string
  relPath: string
  ok: boolean
  code?: string
  message?: string
}

const busy = new Set<string>()

const resolveInside = (root: string, relPath: string) => {
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!rel || rel.split('/').includes('..')) {
    throw new WatermarkEditError('decode', '路径不合法')
  }
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, rel)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new WatermarkEditError('decode', '路径不合法')
  }
  return { rel, abs }
}

const readHeader = async (abs: string) => {
  const handle = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const walkJpegs = async (dir: string, out: string[]) => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkJpegs(abs, out)
    } else if (
      entry.isFile() &&
      JPEG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      out.push(abs)
    }
  }
}

export const scanMountedWatermarks = async (): Promise<WatermarkScanResult> => {
  const mounts = getAllScalableMounts()
  const items: WatermarkHit[] = []
  const unavailable: string[] = []
  let scanned = 0

  for (const mount of mounts) {
    try {
      await stat(mount.root)
    } catch {
      unavailable.push(mount.name)
      continue
    }
    if (path.parse(mount.root).root === path.resolve(mount.root)) {
      unavailable.push(mount.name)
      continue
    }

    const files: string[] = []
    await walkJpegs(mount.root, files)
    for (const abs of files) {
      scanned++
      try {
        const header = await readHeader(abs)
        if (!parseXiaomiWatermark(header)) continue
        const fileStat = await stat(abs)
        const relPath = path.relative(mount.root, abs).replace(/\\/g, '/')
        items.push({
          mount: mount.name,
          mountName: path.basename(mount.root),
          relPath,
          fileName: path.basename(abs),
          size: fileStat.size,
          mtime: fileStat.mtime.toISOString(),
          brand: brandOf(header, 'xiaomi'),
        })
      } catch (error) {
        log().warn(`跳过无法读取的文件 ${abs}`, error)
      }
    }
  }

  items.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh'))
  return { mounts: mounts.length, scanned, unavailable, items }
}

const replaceOriginal = async (abs: string, next: Buffer) => {
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${randomUUID()}.chronoval-wm.tmp`,
  )
  try {
    await writeFile(tmp, next)
    await rename(tmp, abs)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export const removeMountedWatermarks = async (
  files: { mount: string; relPath: string }[],
): Promise<WatermarkRemoveResult[]> => {
  const mounts = new Map(getAllScalableMounts().map((mount) => [mount.name, mount]))
  const results: WatermarkRemoveResult[] = []

  for (const file of files) {
    const mount = mounts.get(file.mount)
    if (!mount) {
      results.push({
        mount: file.mount,
        relPath: file.relPath,
        ok: false,
        code: 'not-found',
        message: '扫描库不存在或未启用',
      })
      continue
    }

    let abs = ''
    let rel = file.relPath
    try {
      const resolved = resolveInside(mount.root, file.relPath)
      abs = resolved.abs
      rel = resolved.rel
    } catch (error) {
      results.push({
        mount: file.mount,
        relPath: file.relPath,
        ok: false,
        code: 'path',
        message: error instanceof Error ? error.message : '路径不合法',
      })
      continue
    }

    if (busy.has(abs)) {
      results.push({
        mount: file.mount,
        relPath: rel,
        ok: false,
        code: 'busy',
        message: '这个文件正在处理',
      })
      continue
    }

    busy.add(abs)
    try {
      const original = await readFile(abs)
      const cleaned = await buildCleanXiaomiJpeg(original)
      await replaceOriginal(abs, cleaned)
      try {
        await libraryScanner.reindexFile(file.mount, rel)
      } catch (error) {
        log().warn(`水印已清除，但缩略图刷新失败 ${abs}`, error)
      }
      results.push({ mount: file.mount, relPath: rel, ok: true })
      log().info(`已清除时间水印 ${abs}`)
    } catch (error) {
      const code = error instanceof WatermarkEditError ? error.code : 'write'
      const message = error instanceof Error ? error.message : '清除失败'
      results.push({
        mount: file.mount,
        relPath: rel,
        ok: false,
        code,
        message,
      })
      log().warn(`清除水印失败，原文件未修改 ${abs}: ${message}`)
    } finally {
      busy.delete(abs)
    }
  }

  return results
}
