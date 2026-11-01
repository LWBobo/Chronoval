export default defineEventHandler(async event => { await requireAccess(event,'admin'); throw createError({statusCode:410,message:'请使用受控上传会话'}) })
