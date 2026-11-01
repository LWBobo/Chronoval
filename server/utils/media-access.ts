import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import { requireVisiblePhoto } from './photo-access'
import { requireMusicAccess } from './music-access'
import { mediaUrlPathMatches } from './media-reference'

async function authorizeFile(event: H3Event, files: Array<typeof tables.photoFiles.$inferSelect>) {
  if(files.length!==1)throw createError({statusCode:404,message:'File not found'})
  const file=files[0]!
  const access=await requireVisiblePhoto(event,file.photoId,{allowAdminDeleted:true,allowOwnerDeleted:true})
  const privileged=access.context.actor.isAdmin||access.context.userId===access.photo.ownerId
  if(access.photo.stripLocation&&!privileged&&['original','live_video'].includes(file.role))throw createError({statusCode:404,message:'File not found'})
  return {...access,file}
}
export function filesByStorageKey(key:string){
  return useDB().select().from(tables.photoFiles).where(and(eq(tables.photoFiles.locatorType,'provider'),eq(tables.photoFiles.storageKey,key),eq(tables.photoFiles.state,'ready'))).limit(2).all()
}
export async function requireStorageKeyAccess(event:H3Event,key:string){return authorizeFile(event,filesByStorageKey(key))}
export async function requireStorageMediaAccess(event:H3Event,key:string){
  const files=filesByStorageKey(key)
  if(files.length)return authorizeFile(event,files)
  const music=useDB().select({id:tables.music.id}).from(tables.music).where(mediaUrlPathMatches(tables.music.coverUrl,`/storage/${key}`)).get()
  if(music)return requireMusicAccess(event,music.id)
  throw createError({statusCode:404,message:'File not found'})
}
export async function requireLibraryMediaAccess(event:H3Event,mount:string,relativePath:string){
  const match=/^scan_(\d+)$/.exec(mount)
  if(!match)throw createError({statusCode:404,message:'File not found'})
  const files=useDB().select().from(tables.photoFiles).where(and(eq(tables.photoFiles.locatorType,'library'),eq(tables.photoFiles.libraryId,Number(match[1])),eq(tables.photoFiles.libraryPath,relativePath),eq(tables.photoFiles.state,'ready'))).limit(2).all()
  return authorizeFile(event,files)
}
export async function requireMediaReferenceAccess(event:H3Event,reference:string){
  const match=/^\/api\/assets\/([a-f0-9]{32})$/.exec(reference.split('?')[0]!)
  if(!match)throw createError({statusCode:404,message:'File not found'})
  return authorizeFile(event,useDB().select().from(tables.photoFiles).where(and(eq(tables.photoFiles.id,match[1]!),eq(tables.photoFiles.state,'ready'))).all())
}
