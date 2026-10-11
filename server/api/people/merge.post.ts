import { z } from 'zod'
import { mergePeople, personWithMeta } from '~~/server/services/ml/person.service'

export default eventHandler(async (event) => {
  await requireUserSession(event)

  const body = await readValidatedBody(
    event,
    z
      .object({
        targetId: z.string().min(1),
        sourceIds: z.array(z.string().min(1)).min(1),
      })
      .parse,
  )

  const person = mergePeople(body.targetId, body.sourceIds)
  return { person: personWithMeta(person!) }
})
