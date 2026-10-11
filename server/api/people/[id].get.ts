import {
  getPerson,
  getPersonPhotoIds,
  personWithMeta,
} from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'Missing person id' })
  }

  const person = getPerson(id)
  if (!person) {
    throw createError({ statusCode: 404, message: 'Person not found' })
  }

  // 隐藏人物仅管理员可见
  if (person.isHidden) {
    const session = await getUserSession(event).catch(() => null)
    if (!(session as any)?.user?.isAdmin) {
      throw createError({ statusCode: 404, message: 'Person not found' })
    }
  }

  const photos = getPersonPhotoIds(id).map((p) => ({
    id: p.id,
    title: p.title,
    thumbnailUrl: p.thumbnailUrl,
    thumbnailHash: p.thumbnailHash,
    aspectRatio: p.aspectRatio,
    width: p.width,
    height: p.height,
    dateTaken: p.dateTaken,
    type: p.type,
  }))

  return {
    person: personWithMeta(person),
    photos,
  }
})
