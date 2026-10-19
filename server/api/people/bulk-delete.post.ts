import { z } from 'zod'
import { deletePeople } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).parse,
  )
  const deleted = deletePeople(body.ids)
  return { deleted }
})
