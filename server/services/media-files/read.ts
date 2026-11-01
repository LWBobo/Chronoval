import { and, eq } from 'drizzle-orm'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { tables, useDB } from '../../utils/db'
import { resolveInsideRoot } from '../../utils/safe-path'
import { FixedStore } from './store'

export function registeredFile(photoId: string, role: typeof tables.photoFiles.$inferSelect['role']) {
  return useDB().select().from(tables.photoFiles).where(and(eq(tables.photoFiles.photoId,photoId),eq(tables.photoFiles.role,role),eq(tables.photoFiles.state,'ready'))).get()
}

export async function registeredFileStream(file: typeof tables.photoFiles.$inferSelect) {
  if (file.state !== 'ready' || file.locatorType === 'embedded') throw new Error('File is not available for processing')
  if (file.locatorType === 'provider') return new FixedStore(file.storageProviderId!).read(file.storageKey!)
  const library = useDB().select().from(tables.libraries).where(eq(tables.libraries.id,file.libraryId!)).get()
  if (!library?.enabled) throw new Error('Library unavailable')
  const root = await realpath(library.rootPath), absolute = await realpath(resolveInsideRoot(root,file.libraryPath!))
  const relative = path.relative(root,absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Invalid library file')
  const metadata = await stat(absolute)
  if (!metadata.isFile() || metadata.size !== file.byteSize) throw new Error('Library file changed')
  return (await open(absolute,constants.O_RDONLY | constants.O_NOFOLLOW)).createReadStream()
}

export async function registeredFileBuffer(photoId: string, roles: Array<typeof tables.photoFiles.$inferSelect['role']> = ['preview','original'], limit = 100 * 1024 ** 2) {
  const file = roles.map(role => registeredFile(photoId,role)).find(Boolean)
  if (!file || file.byteSize > limit) throw new Error('Media file missing or too large')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of await registeredFileStream(file)) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > limit) throw new Error('Media file exceeds processing limit')
    chunks.push(bytes)
  }
  if (size !== file.byteSize) throw new Error('Media file size changed')
  return Buffer.concat(chunks)
}
