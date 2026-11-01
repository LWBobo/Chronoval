import sharp from 'sharp'
import { requireMediaReferenceAccess } from '../../utils/media-access'
import { registeredFileStream } from '../../services/media-files/read'
export default defineEventHandler(async event=>{
 let reference=getRouterParam(event,'thumbnailUrl')||''
 try{reference=decodeURIComponent(reference)}catch{throw createError({statusCode:400,message:'Invalid reference'})}
 const {file}=await requireMediaReferenceAccess(event,reference)
 if(!['thumbnail','poster','preview','sanitized_download'].includes(file.role)||!file.mimeType.startsWith('image/')||file.byteSize>20*1024**2)throw createError({statusCode:404,message:'Thumbnail unavailable'})
 const chunks:Buffer[]=[];let size=0
 for await(const chunk of await registeredFileStream(file)){size+=chunk.length;if(size>20*1024**2)throw createError({statusCode:413,message:'Thumbnail too large'});chunks.push(Buffer.from(chunk))}
 const image=await sharp(Buffer.concat(chunks),{limitInputPixels:100_000_000}).rotate().jpeg({quality:85}).toBuffer()
 setHeader(event,'Cache-Control','private, no-store');setHeader(event,'Vary','Cookie');setHeader(event,'Content-Type','image/jpeg');setHeader(event,'Content-Length',image.length)
 if(event.method==='HEAD'){event.node.res.end();return}
 return image
})
