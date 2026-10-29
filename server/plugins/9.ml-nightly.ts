import { isFaceEnabled } from '../services/ml/config'
import { queueRecognitionSweep } from '../services/ml/face-recognition.service'
import { setMlState } from '../services/ml/state'

const SWEEP_KEY = 'lastRecognitionSweep'

function markSweep() {
  setMlState(SWEEP_KEY, new Date().toISOString())
}

let timer: NodeJS.Timeout | null = null
let stopped = false

const log = logger.dynamic('ml-nightly')

const INTERVAL_MS = Number(
  process.env.ML_NIGHTLY_INTERVAL_MS || 24 * 60 * 60 * 1000,
)

async function tick() {
  if (stopped) return
  try {
    if (!(await isFaceEnabled())) {
      log.info('Face ML disabled; skip recognition sweep')
      return
    }
    await queueRecognitionSweep()
    markSweep()
    log.success('Queued nightly face recognition sweep')
  } catch (err) {
    log.error('Nightly ML recognition sweep failed:', err)
  }
}

function exitHandler() {
  stopped = true
  if (timer) clearTimeout(timer)
}

export default defineNitroPlugin(async (_nitroApp) => {
  const initialDelay = Number(
    process.env.ML_NIGHTLY_INITIAL_DELAY_MS || 5 * 60 * 1000,
  )

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(async () => {
      await tick()
      schedule()
    }, INTERVAL_MS)
  }

  setTimeout(async () => {
    await tick()
    schedule()
  }, initialDelay)

  process.on('SIGINT', exitHandler)
  process.on('SIGTERM', exitHandler)

  log.info(`ML nightly recognition scheduled every ${INTERVAL_MS}ms`)
})
