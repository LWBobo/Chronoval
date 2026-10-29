import { WorkerPool } from '../services/pipeline-queue'
import { whenDatabaseReady } from './0.db-migrate'

export default defineNitroPlugin(async (_nitroApp) => {
  const _logger = logger.dynamic('queue')
  await whenDatabaseReady()

  // ML concurrency is capped in services/ml/limit.ts (CLIP/faces 1, OCR 2)
  // and recognition-lock (clustering is serial). Thumbnail workers stay at 5.
  const workerPool = new WorkerPool(
    {
      workerCount: 5,
      intervalMs: 1500,
      intervalOffset: 300,
      enableLoadBalancing: true,
      statsReportInterval: 60000 * 10,
      completedRetentionDays: Number(
        process.env.PIPELINE_COMPLETED_RETENTION_DAYS || 30,
      ),
      maintenanceIntervalMs: 24 * 60 * 60 * 1000,
    },
    _logger,
  )
  await workerPool.start()

  globalThis.__workerPool = workerPool

  const exitHandler = async () => {
    _logger.info('Shutting down worker pool...')
    await workerPool.stop()
    process.exit(0)
  }

  process.on('SIGINT', exitHandler)
  process.on('SIGTERM', exitHandler)

  // 每 5 分钟进行一次负载均衡检查
  setInterval(
    async () => {
      try {
        await workerPool.rebalance()
      } catch (error) {
        _logger.error('Rebalance failed:', error)
      }
    },
    5 * 60 * 1000,
  )
})
