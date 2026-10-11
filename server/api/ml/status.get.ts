import { eq } from 'drizzle-orm'
import { pingMl } from '~~/server/services/ml/client'
import {
  isClipEnabled,
  isFaceEnabled,
  isMlEnabled,
  isOcrEnabled,
} from '~~/server/services/ml/config'

export default eventHandler(async () => {
  const [enabled, clip, face, ocr, ping] = await Promise.all([
    isMlEnabled(),
    isClipEnabled(),
    isFaceEnabled(),
    isOcrEnabled(),
    pingMl(),
  ])

  const sweep = useDB()
    .select()
    .from(tables.mlState)
    .where(eq(tables.mlState.key, 'lastRecognitionSweep'))
    .get()

  return {
    enabled,
    clip,
    face,
    ocr,
    ping,
    lastRecognitionSweep: sweep?.value ?? null,
  }
})
