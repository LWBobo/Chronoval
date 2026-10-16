import { z } from 'zod'
import { deleteScanLibrary } from '~~/server/services/scan-library/manager'

export default eventHandler(async (event) => {

  const { id } = await getValidatedRouterParams(
    event,
    z.object({ id: z.string().transform((v) => parseInt(v, 10)) }).parse,
  )

  await deleteScanLibrary(id)
  return { success: true }
})