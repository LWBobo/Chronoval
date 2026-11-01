import { and, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import { photoWithMediaColumns } from '../../utils/photo-media'

export default defineEventHandler(async event => {
  await requireAccess(event,'admin')
  const input=await readValidatedBody(event,z.object({fileNames:z.array(z.string().max(1024)).max(500).optional(),storageKeys:z.array(z.string().max(2048)).max(500).optional()}).strict().refine(value=>(value.fileNames?.length??0)+(value.storageKeys?.length??0)>0,'请选择要检查的文件').parse)
  const files=useDB().select({photoId:tables.photoFiles.photoId,filename:tables.photoFiles.originalFilename,key:tables.photoFiles.storageKey}).from(tables.photoFiles).where(and(eq(tables.photoFiles.role,'original'),eq(tables.photoFiles.state,'ready'),or(input.fileNames?.length?inArray(tables.photoFiles.originalFilename,input.fileNames):undefined,input.storageKeys?.length?inArray(tables.photoFiles.storageKey,input.storageKeys):undefined))).all()
  const ids=[...new Set(files.map(file=>file.photoId))]
  const photos=ids.length?useDB().select(photoWithMediaColumns()).from(tables.photos).where(inArray(tables.photos.id,ids)).all():[]
  const queries=[...(input.fileNames??[]).map(fileName=>({fileName,storageKey:undefined as string|undefined})),...(input.storageKeys??[]).map(storageKey=>({fileName:undefined as string|undefined,storageKey}))]
  const results=queries.map(query=>{
    const matching=files.filter(file=>query.fileName!==undefined?file.filename===query.fileName:file.key===query.storageKey)
    const photo=photos.find(row=>row.id===matching[0]?.photoId)??null
    return {...query,photoId:photo?.id??null,exists:matching.length>0,photo,matchingCount:matching.length}
  })
  return {success:true,results,duplicatesFound:results.filter(result=>result.exists).length,policy:'separate-directory'}
})
