export default eventHandler(async (event) => {

  const photoId = getRouterParam(event, 'photoId')

  if (!photoId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Photo ID is required',
    })
  }

  try {
    const { photo } = await requireVisiblePhoto(event, photoId)

    return {
      id: photo.id,
      title: photo.title,
      isLivePhoto: Boolean(photo.isLivePhoto),
      livePhotoVideoUrl: photo.livePhotoVideoUrl,
      originalUrl: photo.originalUrl,
      thumbnailUrl: photo.thumbnailUrl,
    }
  } catch (error: any) {
    if (error?.statusCode) throw error
    logger.chrono.error('Failed to get photo details:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to get photo details',
    })
  }
})
