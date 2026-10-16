export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')

  if (!photoId) {
    return createError({
      statusCode: 400,
      statusMessage: 'Photo ID is required',
    })
  }

  const photo = await useDB()
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo) {
    return createError({
      statusCode: 404,
      statusMessage: 'Photo not found',
    })
  }

  if (photo.deletedAt) {
    return createError({
      statusCode: 409,
      statusMessage: 'Photo is already in the trash',
    })
  }

  logger.image.info(`Moving photo to trash ${photo.title || photo.id || photoId}`)

  // 软删除：仅标记删除时间，不删除任何文件、不删除数据库记录。
  // 原图 / 缩略图 / 实况视频保留在原地，照片从相册/画廊/后台全部隐去，
  // 可在回收站（/dashboard/trash）恢复或彻底删除。
  const db = useDB()
  const linkedPeople = db
    .select({ personId: tables.assetFaces.personId })
    .from(tables.assetFaces)
    .where(eq(tables.assetFaces.photoId, photoId))
    .all()
    .map((f) => f.personId)
    .filter((id): id is string => Boolean(id))

  db.update(tables.photos)
    .set({ deletedAt: new Date() })
    .where(eq(tables.photos.id, photoId))
    .run()

  if (linkedPeople.length) {
    const { reconcilePeople } = await import(
      '~~/server/services/ml/person.service'
    )
    reconcilePeople(linkedPeople)
  }

  logger.image.success(`Photo ${photoId} moved to trash`)

  return {
    statusCode: 200,
    statusMessage: 'Photo moved to trash',
  }
})