import { z } from 'zod'
import { addPhotosToPerson } from '~~/server/services/ml/person.service'

/**
 * 把同一批照片追加到多个人物相册。
 * 走 person_photos，不改人脸框上已有的 personId，所以一张照片可以同时留在多个人物相册里。
 */
export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({
      personIds: z.array(z.string().min(1)).min(1).max(50),
      photoIds: z.array(z.string().min(1)).min(1).max(500),
    }).parse,
  )

  let added = 0
  let already = 0
  const people: string[] = []
  for (const personId of [...new Set(body.personIds)]) {
    try {
      const result = addPhotosToPerson(personId, body.photoIds)
      people.push(personId)
      added += result.added
      already += result.already
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 404) continue
      throw error
    }
  }
  return { added, already, people: people.length }
})
