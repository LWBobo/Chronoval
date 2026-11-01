import { createReadStream, createWriteStream, constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash, randomBytes } from 'node:crypto'
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { StorageConfig } from '../../../shared/types/storage'
import { tables, useDB } from '../../utils/db'
import { eq } from 'drizzle-orm'
import { resolveInsideRoot } from '../../utils/safe-path'

export const randomId = () => randomBytes(16).toString('hex')
export const claimKey = (key: string) => key.normalize('NFC').toLowerCase()

export class FixedStore {
  readonly config: StorageConfig
  readonly providerId: number
  private s3?: S3Client
  constructor(providerId: number) {
    this.providerId = providerId
    const row = useDB().select().from(tables.settingsStorageProviders).where(eq(tables.settingsStorageProviders.id, providerId)).get()
    if (!row) throw createError({ statusCode: 409, message: 'Storage provider unavailable' })
    this.config = row.config
    if (this.config.provider === 's3') this.s3 = new S3Client({ endpoint: this.config.endpoint, region: this.config.region, forcePathStyle: this.config.forcePathStyle, credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey } })
  }
  get supportsManagedUploads() { return this.config.provider === 'local' || this.config.provider === 's3' }
  userRoot(username: string) {
    if (this.config.provider === 'openlist') throw createError({ statusCode: 501, message: '当前存储不支持受控上传，请管理员选择本地或 S3 存储' })
    const prefix = (this.config.prefix || 'photos').replace(/^\/+|\/+$/g, '')
    return `${prefix}/${username}`
  }
  siteRoot(photoId: string) { return `${this.userRoot('.site')}/${photoId}` }
  async assertCapacity(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw createError({ statusCode: 422, message: '无效文件大小' })
    if (this.config.provider !== 'local') return
    await fs.mkdir(this.config.basePath, { recursive: true })
    const space = await fs.statfs(this.config.basePath)
    if (space.bavail * space.bsize < bytes) throw createError({ statusCode: 507, message: '存储磁盘剩余空间不足' })
  }
  async localPath(key: string, createParents = false) {
    if (this.config.provider !== 'local') return null
    await fs.mkdir(this.config.basePath, { recursive: true })
    const root = await fs.realpath(this.config.basePath)
    const target = resolveInsideRoot(root, key)
    const pieces = path.relative(root, target).split(path.sep)
    let current = root
    for (const [index, piece] of pieces.entries()) {
      current = path.join(current, piece)
      if (createParents && index < pieces.length - 1) await fs.mkdir(current).catch((e) => { if (e.code !== 'EEXIST') throw e })
      const stat = await fs.lstat(current).catch((e) => { if (e.code === 'ENOENT') return null; throw e })
      if (stat?.isSymbolicLink()) throw createError({ statusCode: 400, message: 'Symbolic links are not allowed in managed storage' })
    }
    return target
  }
  async meta(key: string): Promise<{ size: number } | null> {
    const local = await this.localPath(key)
    if (local) return fs.stat(local).then((s) => s.isFile() ? { size: s.size } : null).catch((e) => { if (e.code === 'ENOENT') return null; throw e })
    if (this.config.provider === 's3') {
      try { const r = await this.s3!.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key })); return { size: r.ContentLength ?? 0 } } catch (e: any) { if (e.$metadata?.httpStatusCode === 404) return null; throw e }
    }
    throw createError({ statusCode: 501, message: 'Unsupported managed storage' })
  }
  async read(key: string, start?: number, end?: number): Promise<Readable> {
    const local = await this.localPath(key)
    if (local) return (await fs.open(local, constants.O_RDONLY | constants.O_NOFOLLOW)).createReadStream({ start, end })
    if (this.config.provider === 's3') {
      const r = await this.s3!.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: start === undefined ? undefined : `bytes=${start}-${end ?? ''}` }))
      if (!r.Body) throw createError({ statusCode: 404, message: 'File not found' })
      return r.Body as Readable
    }
    throw createError({ statusCode: 501, message: 'Unsupported managed storage' })
  }
  async createExclusive(key: string, sourceFile: string, mime: string) {
    const size = (await fs.stat(sourceFile)).size
    await this.assertCapacity(size)
    const local = await this.localPath(key, true)
    if (local) {
      // A hard link is atomic. The fallback also claims the destination exclusively;
      // its registry entry stays non-readable until size and checksum are verified.
      try { await fs.link(sourceFile, local) } catch (e: any) {
        if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(e.code)) throw e
        let owned = false
        const output = createWriteStream(local, { flags: 'wx', mode: 0o600 })
        output.once('open', () => { owned = true })
        try {
          await pipeline(createReadStream(sourceFile), output)
        } catch (copyError) {
          if (owned) await fs.unlink(local).catch(() => {})
          throw copyError
        }
      }
      return
    }
    if (this.config.provider === 's3') {
      await this.s3!.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: createReadStream(sourceFile), ContentLength: size, ContentType: mime, IfNoneMatch: '*' }))
      return
    }
    throw createError({ statusCode: 501, message: 'Unsupported managed storage' })
  }
  async remove(key: string) {
    const local = await this.localPath(key)
    if (local) { await fs.unlink(local).catch((e) => { if (e.code !== 'ENOENT') throw e }); return }
    if (this.config.provider === 's3') { await this.s3!.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })); return }
    throw createError({ statusCode: 501, message: 'Unsupported managed storage' })
  }
  async checksum(key: string) {
    const hash = createHash('sha256')
    for await (const chunk of await this.read(key)) hash.update(chunk)
    return hash.digest('hex')
  }
}
