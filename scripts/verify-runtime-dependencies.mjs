import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDDsAAAAASUVORK5CYII=', 'base64')

/** Check packaged dependencies without starting the app or opening its database. */
export async function verifyRuntimeDependencies(serverDirectory, only) {
  const root = await realpath(serverDirectory)
  const scratch = await mkdtemp(path.join(tmpdir(), 'chronoval-runtime-check-'))
  const image = path.join(scratch, 'pixel.png')
  const checked = []
  async function load(specifier) {
    // Resolve the same ESM export branches as the production server. Some
    // packages ship separate import/require entries and Nitro copies only one.
    const resolved = await realpath(fileURLToPath(import.meta.resolve(specifier)))
    const relative = path.relative(root, resolved)
    assert(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), `${specifier} resolved outside the packaged server: ${resolved}`)
    return import(pathToFileURL(resolved).href)
  }
  const checks = {
    async 'file-type'() {
      const { fileTypeFromFile, fileTypeFromBuffer } = await load('file-type')
      assert.equal((await fileTypeFromFile(image))?.mime, 'image/png')
      assert.equal((await fileTypeFromBuffer(pixel))?.mime, 'image/png')
      const jpeg = path.join(scratch, 'pixel.jpg')
      await writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF\0'), ...Array(24).fill(0)]))
      assert.equal((await fileTypeFromFile(jpeg))?.mime, 'image/jpeg')
      const mp4 = path.join(scratch, 'clip.mp4')
      await writeFile(mp4, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp42')]))
      assert.equal((await fileTypeFromFile(mp4))?.mime, 'video/mp4')
    },
    async sqlite() {
      const { default: Database } = await load('better-sqlite3')
      const db = new Database(':memory:')
      try { assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1) }
      finally { db.close() }
    },
    async sharp() {
      const { default: sharp } = await load('sharp')
      const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
      assert.equal((await sharp(bytes).metadata()).width, 1)
    },
    async heic() {
      const { default: convert } = await load('heic-convert')
      // An invalid image still initializes the actual decoder/WASM dependency.
      await assert.rejects(convert({ buffer: pixel, format: 'JPEG' }), /not a HEIC image/i)
    },
    async bmp() {
      const module = await load('@vingle/bmp-js')
      assert.equal(typeof (module.default ?? module).decode, 'function')
    },
    async qrcode() {
      const { default: QRCode } = await load('qrcode')
      const bytes = await QRCode.toBuffer('chronoval-runtime-check')
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    },
    async geoip() {
      const { default: geoip } = await load('geoip-lite')
      assert(geoip.lookup('8.8.8.8'), 'Offline GeoIP data is missing or unreadable')
    },
    async takumi() {
      const module = await load('@takumi-rs/core')
      assert.equal(typeof module.Renderer, 'function')
    },
    async s3() {
      const { S3Client, GetObjectCommand } = await load('@aws-sdk/client-s3')
      const { getSignedUrl } = await load('@aws-sdk/s3-request-presigner')
      const client = new S3Client({ region: 'us-east-1', endpoint: 'https://storage.example.invalid', credentials: { accessKeyId: 'runtime-check', secretAccessKey: 'runtime-check' } })
      try {
        const signed = await getSignedUrl(client, new GetObjectCommand({ Bucket: 'runtime-check', Key: 'pixel' }), { expiresIn: 60 })
        assert(new URL(signed).searchParams.has('X-Amz-Signature'))
      } finally { client.destroy() }
    },
    async system() {
      const module = await load('systeminformation')
      const si = module.default ?? module
      await execFileAsync('/bin/sh', ['-c', 'command -v df >/dev/null && df -kP /tmp'], { timeout: 15000 })
      assert(Array.isArray(await si.fsSize()))
    },
    async media() {
      const options = { timeout: 20000, maxBuffer: 1024 * 1024 }
      await execFileAsync(process.env.FFMPEG_PATH || '/usr/bin/ffmpeg', ['-version'], options)
      await execFileAsync(process.env.FFPROBE_PATH || '/usr/bin/ffprobe', ['-version'], options)
      const { ExifTool } = await load('exiftool-vendored')
      const tool = new ExifTool()
      try { assert((await tool.version()) > 0) }
      finally { await tool.end() }
    },
  }
  try {
    await writeFile(image, pixel)
    for (const name of only ?? Object.keys(checks)) {
      assert(Object.hasOwn(checks, name), `Unknown runtime check: ${name}`)
      try { await checks[name]() }
      catch (error) { throw new Error(`Packaged runtime check failed (${name}): ${error.message}`, { cause: error }) }
      checked.push(name)
    }
    return checked
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const checked = await verifyRuntimeDependencies(process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(fileURLToPath(import.meta.url)))
  console.log(`Packaged runtime dependencies verified: ${checked.join(', ')}`)
}
