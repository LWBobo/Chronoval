import { z } from 'zod'
import { addPhotosToAlbums } from '~~/server/services/album-membership'
import { ensureAlbumVisibilityColumn } from '~~/server/utils/albumVisibility'

export default eventHandler(async (event) => {
  ensureAlbumVisibilityColumn()
  const body = await readValidatedBody(
    event,
    z.object({
      albumIds: z.array(z.number().int().positive()).min(1).max(50),
      photoIds: z.array(z.string().min(1)).min(1).max(500),
    }).parse,
  )
  return addPhotosToAlbums(body.albumIds, body.photoIds)
})
