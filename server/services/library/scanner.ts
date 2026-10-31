import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'crypto'
import sharp from 'sharp'
import { and, eq, sql } from 'drizzle-orm'
import { resolveInsideRoot, isRelativePathInsideRoot } from '~~/server/utils/safe-path'
import type {
  LibraryMount,
  LibraryConfig,
} from './config'
import { getLibraryConfig, VIDEO_EXTENSIONS } from './config'
import {
  getAllScalableMounts,
  markScanMountUnavailable,
  recordScanResult,
  unmarkScanMountUnavailable,
} from '../scan-library/manager'
import { probeVideo, extractVideoFrame } from './ffmpeg'
import { generateThumbnailAndHash } from '../image/thumbnail'
import { preprocessImageBuffer } from '../image/processor'
import { extractExifData, extractPhotoInfo } from '../image/exif'
import { parseGPSCoordinates } from '../location/geocoding'
import { compressUint8Array } from '~~/shared/utils/u8array'
import { getStorageManager } from '~~/server/plugins/3.storage'
import type { Photo } from '~~/server/utils/db'
import {
  detectLibraryLivePhoto,
  findSiblingLiveStill,
  libraryFileUrl,
  LIVE_PHOTO_CHECKED,
} from './live-photo'

const log = () => logger.dynamic('library')

const sanitizeRelPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')

/**
 * 根据挂载名 + 相对路径生成稳定且唯一的照片 ID
 */
export const buildLibraryPhotoId = (mount: string, relPath: string): string => {
  const hash = crypto
    .createHash('md5')
    .update(`${mount}:${relPath}`)
    .digest('hex')
    .slice(0, 16)
  const base = path
    .basename(relPath, path.extname(relPath))
    .replace(/\.[a-z0-9]+$/i, '')
  const cleanedBase = (base || 'media').replace(/[^\w\-_.]/g, '_').slice(0, 24)
  return `lib_${cleanedBase}_${hash}`
}

interface ScanResult {
  indexed: number
  updated: number
  failed: number
  errors: string[]
  /** true=该挂载已有扫描在进行中，本次请求被跳过（防止并发重复扫描） */
  skipped?: boolean
}

/**
 * 本地媒体库扫描器
 * - 仅扫描用户显式添加的外部扫描库（scan-library 挂载，经 getLibraryMounts/getAllScalableMounts 获取）
 * - 纯存储目录（/app/storage）绝不参与扫描：上传加密照片实时落盘即展示，无需扫描。
 * - 自动识别外部库内图片 / 视频，自动生成缩略图
 * - 扫描本身不改写原文件（原图始终引用映射目录）；缩略图统一写入内部存储
 *   （本地存储 thumbnails/<mountName>/…，外部库目录不就地生成缩略图）
 * - 去除水印是单独的管理操作，会在校验通过后替换原文件，再经 reindexFile 刷新缩略图
 */
export class LibraryScanner {
  private cfg: LibraryConfig
  private mounts: LibraryMount[]
  /** 正在扫描中的挂载名集合：同一挂载不并发扫描（保存触发的后台扫描与定时/手动扫描可能撞车） */
  private inFlight = new Set<string>()

  constructor() {
    this.cfg = getLibraryConfig()
    // 挂载集合延迟到首次扫描时再构建：getLibraryMounts() 会查询 libraries 表，
    // 而该表在全新部署（空数据库）中需由 0.db-migrate 迁移插件创建。
    // 若在模块加载期（早于任何插件）即查询，会因表不存在而启动崩溃。
    // scanAll / scanMountByName 每次都会主动刷新 this.mounts，
    // collectFiles 仅依赖其扩展名集合，因此此处置空是安全的。
    this.mounts = []
  }

  getConfig() {
    return this.cfg
  }

  /**
   * 扫描单个挂载目录（带并发防护：同一挂载已有扫描进行中时跳过）
   */
  async scanMount(mount: LibraryMount): Promise<ScanResult> {
    if (this.inFlight.has(mount.name)) {
      return { indexed: 0, updated: 0, failed: 0, errors: [], skipped: true }
    }
    this.inFlight.add(mount.name)
    try {
      return await this.scanMountInner(mount)
    } finally {
      this.inFlight.delete(mount.name)
    }
  }

  private async scanMountInner(mount: LibraryMount): Promise<ScanResult> {
    const result: ScanResult = { indexed: 0, updated: 0, failed: 0, errors: [] }
    const storageProvider = getStorageManager()?.getProvider()
    if (!storageProvider) {
      result.errors.push('Storage manager not initialized')
      return result
    }

    let rootExists = false
    try {
      await fs.access(mount.root)
      rootExists = true
    } catch {
      // 目录不存在（未映射），跳过
    }
    if (!rootExists) {
      // 目录被删除/卸载/失去权限：把挂载标记为「临时不可用」，
      // 使画廊/相册/图片路由（经 getLibraryMounts）隐藏整库，不再展示必然加载失败的失效缩略图
      markScanMountUnavailable(mount.name)
      log().warn(`Library mount not available, skipped: ${mount.root}`)
      return result
    }
    // 目录可访问：若此前被判定为不可用，现在恢复为可用，让整库自动回归画廊
    unmarkScanMountUnavailable(mount.name)

    // 防御：禁止把整个文件系统根目录当作媒体库扫描
    if (path.parse(mount.root).root === mount.root) {
      log().error(
        `Refusing to scan filesystem root as library mount: ${mount.root}`,
      )
      return result
    }

    const files = await this.collectFiles(mount.root)

    const seen = new Set<string>()
    for (const absFile of files) {
      try {
        const rel = sanitizeRelPath(path.relative(mount.root, absFile))
        seen.add(rel)
        const stat = await fs.stat(absFile)
        const photoId = buildLibraryPhotoId(mount.name, rel)
        const fileExtEarly = path.extname(absFile).toLowerCase()

        const db = useDB()
        const existing = db
          .select()
          .from(tables.photos)
          .where(eq(tables.photos.id, photoId))
          .get()

        // 实况短片不单独入库，挂到同名静图上。
        if (fileExtEarly === '.mov') {
          const stillAbs = await findSiblingLiveStill(absFile)
          if (stillAbs) {
            const stillRel = path.relative(mount.root, stillAbs).replace(/\\/g, '/')
            const stillId = buildLibraryPhotoId(mount.name, stillRel)
            const still = db
              .select({ id: tables.photos.id, isLivePhoto: tables.photos.isLivePhoto })
              .from(tables.photos)
              .where(eq(tables.photos.id, stillId))
              .get()
            if (still && !still.isLivePhoto) {
              await db
                .update(tables.photos)
                .set({
                  isLivePhoto: 1,
                  livePhotoVideoKey: `${mount.name}/${rel}`,
                  livePhotoVideoUrl: libraryFileUrl(mount.name, rel),
                })
                .where(eq(tables.photos.id, stillId))
                .run()
            }
            if (existing) {
              await db.delete(tables.photos).where(eq(tables.photos.id, photoId)).run()
            }
            continue
          }
        }

        // 已存在且未被更新，跳过；缺缩略图（如早期 ffmpeg 抽帧失败）的文件不跳过，
        // 重新处理以补生成缩略图，确保历史视频重扫后也能显示卡片图。
        // 还没判断过动态照片的静图只补这一项，不重做缩略图。
        if (
          existing &&
          existing.lastModified === stat.mtime.toISOString() &&
          existing.thumbnailUrl
        ) {
          if (
            existing.type !== 'video' &&
            !existing.isLivePhoto &&
            existing.livePhotoVideoKey !== LIVE_PHOTO_CHECKED
          ) {
            const rawBuffer = await fs.readFile(absFile)
            const live = await detectLibraryLivePhoto({
              photoId,
              mountName: mount.name,
              rel,
              absFile,
              rawBuffer,
              exifData: existing.exif,
            })
            await db
              .update(tables.photos)
              .set(live)
              .where(eq(tables.photos.id, photoId))
              .run()
          }
          continue
        }

        const changed = existing !== undefined
        const entry = await this.processFile(mount, rel, absFile, stat, storageProvider)
        if (!entry) {
          result.failed++
          await this.enqueueFailedFile(
            mount.name,
            rel,
            stat.mtime.toISOString(),
            '文件处理返回空（可能是不支持的格式或文件已损坏）',
          )
          continue
        }

        if (changed) {
          result.updated++
          await db.update(tables.photos).set(entry).where(eq(tables.photos.id, photoId)).run()
        } else {
          result.indexed++
          await db.insert(tables.photos).values({ id: photoId, ...entry }).run()
        }

        // 入库成功后异步入队 ML（CLIP / 人脸 / OCR），失败不影响扫描主流程
        try {
          const { enqueueMlJobsForPhoto } = await import('../ml/enqueue')
          await enqueueMlJobsForPhoto(photoId)
        } catch {
          /* ML enqueue optional */
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`${path.basename(absFile)}: ${msg}`)
        result.failed++
        const rel = sanitizeRelPath(path.relative(mount.root, absFile))
        let mtime: string | undefined
        try {
          mtime = (await fs.stat(absFile)).mtime.toISOString()
        } catch {
          /* File may have disappeared since collection. */
        }
        await this.enqueueFailedFile(mount.name, rel, mtime, msg)
      }
    }

    // 清理已失效的条目：文件已从挂载目录移除/变更挂载点后，删除旧 library 记录，避免残留垃圾
    try {
      const db = useDB()
      const stale = db
        .select({ id: tables.photos.id, libraryPath: tables.photos.libraryPath })
        .from(tables.photos)
        .where(eq(tables.photos.source, 'library'))
        .where(eq(tables.photos.libraryMount, mount.name))
        .all()
        .filter((row) => row.libraryPath && !seen.has(row.libraryPath))
      if (stale.length) {
        for (const row of stale) {
          await db
            .delete(tables.photos)
            .where(eq(tables.photos.id, row.id))
            .run()
        }
        log().info(`Pruned ${stale.length} stale library entry(ies) from "${mount.name}"`)
      }
    } catch (pruneErr) {
      log().warn(`Failed to prune stale library entries:`, pruneErr)
    }

    // 空闲扫描（indexed/updated/failed 全为 0 时）保持静默，避免轮询循环刷屏；
    // 仅在确有增删改或失败时输出 info，合并为一行便于排查
    const hasWork =
      result.indexed > 0 || result.updated > 0 || result.failed > 0
    log()[hasWork ? 'info' : 'debug'](
      `Scan "${mount.name}" at ${mount.root}: found ${files.length} media file(s); ` +
        `done: indexed=${result.indexed} updated=${result.updated} failed=${result.failed}`,
    )
    // 回写扫描库最近状态（挂载名为 scan_<id> 时）
    recordScanResult(mount.name, {
      indexed: result.indexed,
      updated: result.updated,
      failed: result.failed,
    })
    return result
  }

  /**
   * 扫描全部挂载目录
   */
  async scanAll(): Promise<Record<string, ScanResult>> {
    // 每次从数据库重建挂载集合：新增/启用的扫描库立即生效（无需重启）。
    // 用 getAllScalableMounts()（含临时不可用挂载）以便持续探测、目录恢复后自动回归画廊
    this.mounts = getAllScalableMounts()
    const out: Record<string, ScanResult> = {}
    for (const mount of this.mounts) {
      out[mount.name] = await this.scanMount(mount)
    }
    return out
  }

  /**
   * 按挂载名触发单目录扫描（供“立即扫描”使用）
   */
  async scanMountByName(name: string): Promise<ScanResult | null> {
    this.mounts = getAllScalableMounts()
    const mount = this.mounts.find((m) => m.name === name)
    return mount ? await this.scanMount(mount) : null
  }

  /**
   * 扫描失败的文件入队为 library-file 任务：
   * - 队列管理页（/dashboard/queue）可见失败原因，可手动重试
   * - 工作器自动重试，瞬时故障（网络挂载抖动等）可自愈
   * - 去重：同挂载+同路径已有进行中任务、或同文件版本（mtime）已失败任务时跳过
   */
  private async enqueueFailedFile(
    mountName: string,
    relPath: string,
    lastModified?: string,
    reason?: string,
  ): Promise<void> {
    try {
      const db = useDB()
      const sameKeyTasks = db
        .select({
          id: tables.pipelineQueue.id,
          status: tables.pipelineQueue.status,
          payload: tables.pipelineQueue.payload,
        })
        .from(tables.pipelineQueue)
        .where(
          and(
            sql`json_extract(${tables.pipelineQueue.payload}, '$.type') = 'library-file'`,
            sql`json_extract(${tables.pipelineQueue.payload}, '$.mount') = ${mountName}`,
            sql`json_extract(${tables.pipelineQueue.payload}, '$.libraryPath') = ${relPath}`,
          ),
        )
        .all()

      const hasActive = sameKeyTasks.some(
        (t) => t.status === 'pending' || t.status === 'in-stages',
      )
      const hasSameVersionFailed = sameKeyTasks.some(
        (t) =>
          t.status === 'failed' &&
          t.payload.type === 'library-file' &&
          t.payload.lastModified === lastModified,
      )
      if (hasActive || hasSameVersionFailed) return

      const pool = globalThis.__workerPool
      if (!pool) {
        log().warn('Worker pool not ready, skip enqueue failed library file')
        return
      }
      await pool.addTask(
        {
          type: 'library-file',
          mount: mountName,
          libraryPath: relPath,
          ...(lastModified ? { lastModified } : {}),
          ...(reason ? { reason } : {}),
        },
        { maxAttempts: 3 },
      )
      log().info(
        `Enqueued failed library file for retry: ${mountName}/${relPath}`,
      )
    } catch (err) {
      // 入队失败不影响扫描主流程
      log().warn(
        `Failed to enqueue failed library file ${mountName}/${relPath}:`,
        err,
      )
    }
  }

  /**
   * 重新处理队列中的单个文件，沿用扫描库的动态照片识别和 ML 入队规则。
   */
  async processSingleFile(
    mountName: string,
    relPath: string,
  ): Promise<'indexed' | 'updated'> {
    const mount = getAllScalableMounts().find((item) => item.name === mountName)
    if (!mount) throw new Error(`Library mount not found: ${mountName}`)

    const requestedPath = resolveInsideRoot(mount.root, sanitizeRelPath(relPath))
    const [realRoot, realFile] = await Promise.all([
      fs.realpath(mount.root),
      fs.realpath(requestedPath),
    ])
    if (!isRelativePathInsideRoot(path.relative(realRoot, realFile))) {
      throw new Error('Library file is outside its mount')
    }
    const rel = path.relative(path.resolve(mount.root), requestedPath).split(path.sep).join('/')
    const stat = await fs.stat(requestedPath)
    if (!stat.isFile() || !mount.extensions.has(path.extname(rel).toLowerCase())) {
      throw new Error(`Unsupported library file: ${rel}`)
    }
    const storageProvider = getStorageManager()?.getProvider()
    if (!storageProvider) throw new Error('Storage manager not initialized')

    const db = useDB()
    const photoId = buildLibraryPhotoId(mountName, rel)

    // 同名 MOV 是实况短片，重试仍归入静图，不生成重复的视频卡片。
    if (path.extname(rel).toLowerCase() === '.mov') {
      const still = await findSiblingLiveStill(requestedPath)
      if (still) {
        const outcome = await this.processSingleFile(
          mountName,
          path.relative(mount.root, still),
        )
        db.delete(tables.photos).where(eq(tables.photos.id, photoId)).run()
        return outcome
      }
    }

    const existing = db
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(eq(tables.photos.id, photoId))
      .get()
    const entry = await this.processFile(
      mount, rel, requestedPath, stat, storageProvider,
    )
    if (!entry) throw new Error(`Failed to process library file: ${rel}`)

    // 重试与周期扫描可能重叠；按稳定 ID upsert，保留未参与更新的人工信息。
    db.insert(tables.photos)
      .values({ id: photoId, ...entry })
      .onConflictDoUpdate({ target: tables.photos.id, set: entry })
      .run()
    try {
      const { enqueueMlJobsForPhoto } = await import('../ml/enqueue')
      await enqueueMlJobsForPhoto(photoId)
    } catch {
      /* ML enqueue optional, as in a full scan. */
    }
    return existing ? 'updated' : 'indexed'
  }

  /**
   * 原文件已被外部操作改写后，按当前字节重建缩略图和入库字段。
   * 记录还不存在时不新建，留给下一次全库扫描。
   */
  async reindexFile(mountName: string, relPath: string): Promise<void> {
    this.mounts = getAllScalableMounts()
    const mount = this.mounts.find((item) => item.name === mountName)
    if (!mount) return

    const rel = sanitizeRelPath(relPath)
    const root = path.resolve(mount.root)
    const absFile = path.resolve(root, rel)
    if (absFile !== root && !absFile.startsWith(root + path.sep)) return

    const storageProvider = getStorageManager()?.getProvider()
    if (!storageProvider) return

    const stat = await fs.stat(absFile)
    const entry = await this.processFile(mount, rel, absFile, stat, storageProvider)
    if (!entry) return

    // 缩略图路径不变，存储接口又按一年不变缓存。换地址后画廊才会拉到新图。
    if (entry.thumbnailUrl) {
      const base = entry.thumbnailUrl.split('?')[0]
      entry.thumbnailUrl = `${base}?v=${Math.trunc(stat.mtimeMs)}`
    }

    const db = useDB()
    const photoId = buildLibraryPhotoId(mount.name, rel)
    const existing = db
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(eq(tables.photos.id, photoId))
      .get()
    if (!existing) return

    await db
      .update(tables.photos)
      .set(entry)
      .where(eq(tables.photos.id, photoId))
      .run()
  }

  /**
 * 本地扫描库索引根目录内的子目录名：含缩略图目录、隐藏目录等，均跳过不扫
 */
private static readonly LIBRARY_SKIP_DIRS = new Set([
  '.thumbnails',
  'thumbnails',
  '.thumb',
  '.thumbs',
])

/**
 * 递归收集目录内支持的媒体文件
 */
private async collectFiles(dir: string): Promise<string[]> {
    const results: string[] = []
    const exts = new Set<string>()
    for (const mount of this.mounts) {
      for (const e of mount.extensions) exts.add(e)
    }

    const walk = async (current: string) => {
      let entries
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const skipName = LibraryScanner.LIBRARY_SKIP_DIRS.has(entry.name)
        if (entry.name.startsWith('.') || skipName) continue
        const abs = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(abs)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (exts.has(ext)) results.push(abs)
        }
      }
    }

    await walk(dir)
    return results
  }

  /**
   * 处理单个媒体文件：提取元数据 + 生成缩略图，返回入库字段
   */
  private async processFile(
    mount: LibraryMount,
    rel: string,
    absFile: string,
    stat: Awaited<ReturnType<typeof fs.stat>>,
    storageProvider: any,
  ): Promise<Partial<Photo> | null> {
    const photoId = buildLibraryPhotoId(mount.name, rel)
    // 原文件只读引用：通过 /library/<mountName>/<relpath> 访问
    const originalUrl = libraryFileUrl(mount.name, rel)

    // 缩略图统一写入内部存储（与上传缩略图同源）：
    // 不再就地写入外部库目录，外部库保持纯只读原图。本地存储下 URL 为
    // /storage/thumbnails/<mountName>/<id>.webp，可被 thumb 路由读取渲染。
    const thumbFileName = `${photoId}.webp`

    const writeThumbnail = async (
      buffer: Buffer,
    ): Promise<{ key: string; url: string } | null> => {
      const provider = storageProvider
      if (!provider) return null
      try {
        const obj = await provider.create(
          `thumbnails/${mount.name}/${thumbFileName}`,
          buffer,
          'image/webp',
        )
        return { key: obj.key, url: provider.getPublicUrl(obj.key) }
      } catch (err) {
        log().warn(
          `Failed to write thumbnail for ${absFile} to storage:`,
          err,
        )
        return null
      }
    }

    // 一个文件夹内可混放图片和视频：按单个文件扩展名判定类型
    const fileExt = path.extname(absFile).toLowerCase()
    const isImage = !VIDEO_EXTENSIONS.has(fileExt)

    if (isImage) {
      try {
        const rawBuffer = await fs.readFile(absFile)
        // HEIC/RAW 等需转 JPEG 预览（对 exif/sharp 友好），其余格式原样返回
        const imageBuffer = await preprocessImageBuffer(rawBuffer, absFile)

        const { width, height } = await sharp(imageBuffer, {
          limitInputPixels: false,
        })
          .rotate()
          .metadata()
        // GIF：生成动画缩略图（animated webp），网格卡片也保持动态效果；
        // 限制宽度控制体积（动画逐帧编码，过大缩略图会显著膨胀）
        const isAnimatedGif = fileExt === '.gif'
        const { thumbnailBuffer, thumbnailHash } =
          await generateThumbnailAndHash(
            imageBuffer,
            undefined,
            isAnimatedGif ? { animated: true, width: 640 } : {},
          )

        // 缩略图统一写入内部存储（不就地写外部库目录；见 writeThumbnail）
        const thumb = await writeThumbnail(thumbnailBuffer)

        // EXIF
        let exifData: Awaited<ReturnType<typeof extractExifData>> = null
        try {
          exifData = await extractExifData(imageBuffer, imageBuffer)
        } catch {
          /* ignore */
        }
        const photoInfo = extractPhotoInfo(rel, exifData)
        const coords = exifData ? parseGPSCoordinates(exifData) : null
        const live = await detectLibraryLivePhoto({
          photoId,
          mountName: mount.name,
          rel,
          absFile,
          rawBuffer,
          exifData,
        })

        return {
          title: photoInfo.title,
          description: photoInfo.description,
          width: width || null,
          height: height || null,
          aspectRatio:
            width && height && height > 0 ? width / height : null,
          dateTaken: photoInfo.dateTaken,
          storageKey: `${mount.name}/${rel}`,
          thumbnailKey: thumb?.key || null,
          fileSize: stat.size,
          lastModified: stat.mtime.toISOString(),
          originalUrl,
          thumbnailUrl: thumb?.url || null,
          thumbnailHash: thumbnailHash
            ? compressUint8Array(thumbnailHash)
            : null,
          tags: photoInfo.tags,
          exif: exifData,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
          type: 'image',
          source: 'library',
          libraryMount: mount.name,
          libraryId: mount.name.startsWith('scan_')
            ? Number(mount.name.slice(5)) || null
            : null,
          libraryPath: rel,
          ...live,
        }
      } catch (err) {
        log().warn(`Failed to process library image ${absFile}:`, err)
        return null
      }
    }

    // video
    try {
      const probe = await probeVideo(absFile)
      const durationSec = probe?.duration || 0
      let frame = await extractVideoFrame(absFile, durationSec)
      let thumbnailBuffer: Buffer | null = null
      let thumbnailHash: any = null
      let width: number | null = probe?.width || null
      let height: number | null = probe?.height || null

      if (frame) {
        try {
          const { thumbnailBuffer: tb, thumbnailHash: th } =
            await generateThumbnailAndHash(frame)
          thumbnailBuffer = tb
          thumbnailHash = th
        } catch {
          // fallback: use raw frame
          thumbnailBuffer = frame
        }
      }

      let thumb: { key: string; url: string } | null = null
      if (thumbnailBuffer) {
        thumb = await writeThumbnail(thumbnailBuffer)
      }

      const dbWidth = width || null
      const dbHeight = height || null

      return {
        title: path.basename(rel, path.extname(rel)),
        description: '',
        width: dbWidth,
        height: dbHeight,
        aspectRatio:
          dbWidth && dbHeight && dbHeight > 0 ? dbWidth / dbHeight : 16 / 9,
        dateTaken: stat.mtime.toISOString(),
        storageKey: `${mount.name}/${rel}`,
        thumbnailKey: thumb?.key || null,
        fileSize: stat.size,
        lastModified: stat.mtime.toISOString(),
        originalUrl,
        thumbnailUrl: thumb?.url || null,
        thumbnailHash: thumbnailHash ? compressUint8Array(thumbnailHash) : null,
        tags: ['video'],
        exif: null,
        type: 'video',
        source: 'library',
        libraryMount: mount.name,
        libraryId: mount.name.startsWith('scan_')
          ? Number(mount.name.slice(5)) || null
          : null,
        libraryPath: rel,
      }
    } catch (err) {
      log().warn(`Failed to process library video ${absFile}:`, err)
      return null
    }
  }
}

export const libraryScanner = new LibraryScanner()

export type { LibraryConfig, LibraryMount }
