import { getMlState } from '~~/server/services/ml/state'
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

  const lastRecognitionSweep = getMlState('lastRecognitionSweep')

  return {
    enabled,
    clip,
    face,
    ocr,
    ping,
    lastRecognitionSweep,
  }
})
