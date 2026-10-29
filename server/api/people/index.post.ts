import { z } from 'zod'
import { createPerson } from '~~/server/services/ml/person.service'

/** 不依赖人脸检测，直接新建一本人物相册。 */
export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({
      name: z.string().trim().min(1).max(80),
      visibility: z.enum(['public', 'login', 'admin']).optional(),
    }).parse,
  )
  const person = createPerson(body.name, {
    origin: 'manual',
    visibility: body.visibility ?? 'public',
  })
  if (!person) {
    throw createError({ statusCode: 500, message: 'Failed to create person' })
  }
  return { person }
})
