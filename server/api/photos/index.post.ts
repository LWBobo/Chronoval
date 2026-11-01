import path from 'node:path'
import { z } from 'zod'
import { initializeUpload, uploadInputSchema } from '../../services/uploads'
import { generateSafePhotoId } from '../../utils/file-utils'
import { getScanLibraryRow, scanMountName } from '../../services/scan-library/manager'
export default defineEventHandler(async event=>{
  const actor=await requireAccess(event,'admin')
  const {fileName,contentType,size,idempotencyKey,targetLibraryId,stripLocation}=await readValidatedBody(event,z.object({fileName:z.string().min(1).max(1024),contentType:z.string().max(255).default('application/octet-stream'),size:z.number().int().positive(),idempotencyKey:z.string().min(8).max(128),targetLibraryId:z.number().int().positive().optional(),stripLocation:z.boolean().default(false)}).strict().parse)
    // —— 上传到指定「外部扫描库」——
    // 上传目标是一种轻量的「假预签名」：客户端把 body PUT 到写库端点，
    // 由服务端将文件落盘到所选扫描库的挂载目录，稍后触发库扫描使其被索引。
    if (targetLibraryId != null) {
      const lib = getScanLibraryRow(Number(targetLibraryId))
      if (!lib || !lib.enabled) {
        throw createError({
          statusCode: 400,
          statusMessage: 'settings.storage.scanLibrary.upload.invalidLibrary',
        })
      }
      const ext = path.extname(fileName).toLowerCase()
      const base = path.basename(fileName, ext)
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const safeName = generateSafePhotoId(base) || 'photo'
      // 统一落在 rootPath/uploads/ 子目录，避免污染库根；写库端点会再做路径校验
      const relKey = `uploads/${stamp}_${safeName}${ext}`
      return {
        signedUrl: `/api/photos/library-upload?library=${lib.id}&key=${encodeURIComponent(relKey)}`,
        fileKey: relKey,
        library: { id: lib.id, name: lib.name, mount: scanMountName(lib.id) },
        expiresIn: 3600,
      }
    }

  const session=await initializeUpload(actor,uploadInputSchema.parse({idempotencyKey,stripLocation,parts:[{role:'original',relativePath:fileName,size,mime:contentType}]}),null)
  return {signedUrl:session.parts[0]!.url,fileKey:session.photoId,uploadSessionId:session.id,expiresIn:3600}
})
