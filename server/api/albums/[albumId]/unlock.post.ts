import { z } from 'zod'
import { authorizeAlbum } from '~~/server/utils/manualAlbumAuth'
import { isPasswordExemptForUser } from '~~/server/utils/albumPasswordExempt'
import { verifyAlbumPassword } from '~~/server/utils/scanAlbumPassword'
import { isAlbumAdminBypass } from '~~/server/utils/albumAccess'
import { getManualAlbumByPublicKey } from '~~/server/services/collections/manual-album'
import { albumOpenToActor } from '~~/server/utils/albumVisibility'

export default eventHandler(async (event) => {
  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({ albumId: z.string().min(1) }).parse,
  )
  const body = await readValidatedBody(
    event,
    z.object({ password: z.string() }).parse,
  )

  assertRateLimit(event, {
    namespace: 'album-unlock',
    subject: albumId,
    limit: 15,
    windowMs: 10 * 60 * 1000,
  })

  const album = getManualAlbumByPublicKey(albumId)
  if (!album) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const actor = await getActor(event)
  if (!albumOpenToActor(album, actor)) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const adminBypass = await isAlbumAdminBypass(event, actor)
  if (adminBypass || isPasswordExemptForUser(album, actor.user)) {
    await authorizeAlbum(event, { albumId: album.id, passwordHash: album.passwordHash })
    return { authorized: true }
  }

  if (
    !album.passwordHash ||
    !(await verifyAlbumPassword(album.passwordHash, body.password))
  ) {
    throw createError({ statusCode: 401, statusMessage: 'Incorrect password' })
  }

  await authorizeAlbum(event, { albumId: album.id, passwordHash: album.passwordHash })
  return { authorized: true }
})
