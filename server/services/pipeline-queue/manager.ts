import type { ConsolaInstance } from 'consola'
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import type {
  NewPipelineQueueItem,
  PipelineQueueItem,
} from '~~/server/utils/db'
import {
  extractLocationFromGPS,
  parseGPSCoordinates,
} from '../location/geocoding'
import { settingsManager } from '../settings/settingsManager'

export class QueueManager {
  private static instances: Map<string, QueueManager> = new Map()
  private workerId: string
  private logger: ConsolaInstance
  private isProcessing: boolean = false
  private processingInterval: NodeJS.Timeout | null = null
  private processedCount: number = 0
  private errorCount: number = 0
  private startTime: Date

  static getInstance(
    workerId: string = 'default',
    logger?: ConsolaInstance,
  ): QueueManager {
    if (!QueueManager.instances.has(workerId)) {
      QueueManager.instances.set(workerId, new QueueManager(workerId, logger))
    }
    return QueueManager.instances.get(workerId)!
  }

  static getAllInstances(): QueueManager[] {
    return Array.from(QueueManager.instances.values())
  }

  private constructor(workerId: string, _logger?: ConsolaInstance) {
    this.workerId = workerId
    this.logger = _logger
      ? _logger.withTag(`${workerId}`)
      : logger.dynamic(`queue-${workerId}`)
    this.startTime = new Date()
  }

  getWorkerId(): string {
    return this.workerId
  }

  getStats() {
    const uptime = Date.now() - this.startTime.getTime()
    return {
      workerId: this.workerId,
      isProcessing: this.isProcessing,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      uptime: Math.floor(uptime / 1000), // seconds
      successRate:
        this.processedCount > 0
          ? (this.processedCount / (this.processedCount + this.errorCount)) *
            100
          : 0,
    }
  }

  /**
   * 插入新任务到队列
   * @param payload 任务负荷
   * @param options 可选的任务设置
   * @returns 新创建任务的 ID
   */
  async addTask(
    payload: any,
    options?: Partial<NewPipelineQueueItem>,
  ): Promise<number> {
    const db = useDB()
    const result = db
      .insert(tables.pipelineQueue)
      .values({
        payload,
        ...options,
      })
      .returning({ id: tables.pipelineQueue.id })
      .get()
    return result.id
  }

  /**
   * 获取任务状态
   * @param taskId 任务ID
   * @returns 任务状态信息
   */
  async getTaskStatus(taskId: number) {
    const db = useDB()
    const task = await db
      .select()
      .from(tables.pipelineQueue)
      .where(eq(tables.pipelineQueue.id, taskId))
      .get()
    return task
  }

  /**
   * 获取并锁定下一个待处理任务
   * @returns 下一个待处理任务
   */
  async getNextTask(): Promise<PipelineQueueItem | null> {
    const db = useDB()

    // 使用同步事务防止竞态条件
    const task = db.transaction((tx) => {
      const now = new Date()
      // createdAt in the future = retry backoff (see markTaskFailed).
      const highestPriorityPendingTask = tx
        .select()
        .from(tables.pipelineQueue)
        .where(
          and(
            eq(tables.pipelineQueue.status, 'pending'),
            lte(tables.pipelineQueue.createdAt, now),
          ),
        )
        // 优先处理高优先级和较早创建的任务
        .orderBy(
          desc(tables.pipelineQueue.priority),
          asc(tables.pipelineQueue.createdAt),
        )
        .limit(1)
        .get()

      if (!highestPriorityPendingTask) return null

      const task = highestPriorityPendingTask
      tx.update(tables.pipelineQueue)
        .set({ status: 'in-stages' })
        .where(eq(tables.pipelineQueue.id, task.id))
        .run()

      return { ...task, status: 'in-stages' as const }
    })

    return task
  }

  /**
   * Put a claimed task back to pending without consuming an attempt
   * (e.g. recognition lock busy). Optional delay via future createdAt.
   */
  async releaseTaskToPending(
    taskId: number,
    options?: { delayMs?: number; priority?: number },
  ): Promise<void> {
    const db = useDB()
    const patch: {
      status: 'pending'
      createdAt?: Date
      priority?: number
    } = { status: 'pending' }
    if (options?.delayMs && options.delayMs > 0) {
      patch.createdAt = new Date(Date.now() + options.delayMs)
    }
    if (options?.priority !== undefined) {
      patch.priority = options.priority
    }
    await db
      .update(tables.pipelineQueue)
      .set(patch)
      .where(eq(tables.pipelineQueue.id, taskId))
  }

  /**
   * 更新任务阶段
   * @param taskId 任务ID
   * @param stage 新的任务阶段
   */
  async updateTaskStage(
    taskId: number,
    stage: PipelineQueueItem['statusStage'],
  ): Promise<void> {
    const db = useDB()
    await db
      .update(tables.pipelineQueue)
      .set({ statusStage: stage })
      .where(eq(tables.pipelineQueue.id, taskId))
  }

  /**
   * 标记任务为已完成
   * @param taskId 任务ID
   */
  async markTaskCompleted(taskId: number): Promise<void> {
    const db = useDB()
    await db
      .update(tables.pipelineQueue)
      .set({
        status: 'completed',
        completedAt: sql`(unixepoch())`,
      })
      .where(eq(tables.pipelineQueue.id, taskId))
  }

  /**
   * 标记任务为失败
   * @param taskId 任务ID
   * @param errorMessage 错误信息
   */
  async markTaskFailed(taskId: number, errorMessage?: string): Promise<void> {
    const db = useDB()
    const task = await db
      .select()
      .from(tables.pipelineQueue)
      .where(eq(tables.pipelineQueue.id, taskId))
      .get()

    if (!task) return

    const newAttempts = task.attempts + 1
    const shouldRetry = newAttempts < task.maxAttempts

    // 计算重试延迟（指数退避）
    const retryDelay = shouldRetry
      ? Math.min(1000 * Math.pow(2, newAttempts - 1), 30000)
      : 0

    await db
      .update(tables.pipelineQueue)
      .set({
        status: shouldRetry ? 'pending' : 'failed',
        attempts: newAttempts,
        errorMessage: errorMessage || 'Unknown error',
        // 如果重试，设置延迟重试时间
        ...(shouldRetry && retryDelay > 0
          ? {
              createdAt: new Date(Date.now() + retryDelay),
            }
          : {}),
      })
      .where(eq(tables.pipelineQueue.id, taskId))

    if (!shouldRetry && ['photo-process','photo','photo-erase-location'].includes(task.payload.type) && 'photoId' in task.payload) {
      db.update(tables.photos).set({ processingStatus: 'failed', processingErrorCode: 'PROCESSING_TASK_EXHAUSTED', updatedAt: new Date() }).where(and(eq(tables.photos.id, task.payload.photoId), eq(tables.photos.processingStatus, 'processing'), eq(tables.photos.transferState, 'idle'))).run()
    }
    if (shouldRetry) {
      this.logger.warn(
        `Task ${taskId} failed (attempt ${newAttempts}/${task.maxAttempts}), will retry in ${retryDelay}ms: ${errorMessage}`,
      )
    } else {
      this.logger.error(
        `Task ${taskId} failed permanently after ${newAttempts} attempts: ${errorMessage}`,
      )
    }
  }

  /** 任务处理器 */
  private processors = (() => {
    return {
      photo: async (task: PipelineQueueItem) => {if(task.payload.type!=='photo')throw new Error('Invalid task');const {reprocessRegisteredPhoto}=await import('../media-files/reprocess');await reprocessRegisteredPhoto(task.payload.photoId,task.payload.eraseLocation)},
      reverseGeocoding: async (task: PipelineQueueItem) => {
        const db = useDB()
        const { id: taskId, payload } = task

        if (payload.type !== 'photo-reverse-geocoding') {
          throw new Error(
            `Invalid payload type for reverse geocoding task: ${payload.type}`,
          )
        }

        const { photoId } = payload

        try {
          await this.updateTaskStage(taskId, 'reverse-geocoding')
          this.logger.info(
            `[${taskId}:in-stage] reverse geocoding for photo ${photoId}`,
          )

          const photo = await db
            .select()
            .from(tables.photos)
            .where(eq(tables.photos.id, photoId))
            .get()

          if (!photo) {
            this.logger.warn(
              `[${taskId}:reverse-geocoding] photo ${photoId} not found`,
            )
            throw new Error(`Photo ${photoId} not found`)
          }

          if (photo.deletedAt || photo.stripLocation || photo.transferState !== 'idle' || photo.processingStatus !== 'ready') return
          const fence = and(eq(tables.photos.id, photoId), eq(tables.photos.metadataVersion, photo.metadataVersion), eq(tables.photos.transferState, 'idle'), eq(tables.photos.processingStatus, 'ready'), eq(tables.photos.stripLocation, false), sql`${tables.photos.ownerId} IS ${photo.ownerId}`)
          let latitude = payload.latitude ?? photo.latitude ?? undefined
          let longitude = payload.longitude ?? photo.longitude ?? undefined

          if (
            latitude === undefined ||
            latitude === null ||
            longitude === undefined ||
            longitude === null
          ) {
            if (photo.exif) {
              const coords = parseGPSCoordinates(photo.exif)
              if (latitude === undefined || latitude === null) {
                latitude = coords.latitude
              }
              if (longitude === undefined || longitude === null) {
                longitude = coords.longitude
              }
            }
          }

          const hasLatitude = latitude !== undefined && latitude !== null
          const hasLongitude = longitude !== undefined && longitude !== null

          if (!hasLatitude || !hasLongitude) {
            this.logger.warn(
              `[${taskId}:reverse-geocoding] missing coordinates for photo ${photoId}`,
            )
            await db
              .update(tables.photos)
              .set({
                latitude: null,
                longitude: null,
                country: null,
                city: null,
                locationName: null,
              })
              .where(fence)
            throw new Error(`Missing coordinates for photo ${photoId}`)
          }

          const locationInfo = await extractLocationFromGPS(
            latitude!,
            longitude!,
          )

          if (!locationInfo) {
            throw new Error(
              `Failed to extract location from GPS coordinates (${latitude}, ${longitude}), maybe network issue?`,
            )
          }

          await db
            .update(tables.photos)
            .set({
              latitude: latitude!,
              longitude: longitude!,
              country: locationInfo.country ?? null,
              city: locationInfo.city ?? null,
              locationName: locationInfo.locationName ?? null,
            })
            .where(fence)

          this.logger.success(
            `[${taskId}:reverse-geocoding] updated location for photo ${photoId}`,
          )
        } catch (error) {
          this.logger.error(
            `[${taskId}:reverse-geocoding] failed for photo ${photoId}`,
            error,
          )
          throw error
        }
      },
      eraseLocation: async (task: PipelineQueueItem) => {
        if(task.payload.type!=='photo-erase-location')throw new Error('Invalid task')
        const { sanitizePhotoLocation }=await import('../media-files/sanitize')
        await sanitizePhotoLocation(task.payload.photoId)
      },
      livePhotoDetect: async (task: PipelineQueueItem) => {
        if (task.payload.type !== 'live-photo-video') throw new Error('Invalid task')
        const { processSpecificLivePhotoVideo } = await import('../video/scanner')
        await processSpecificLivePhotoVideo(task.payload.photoId)
      },
    }
  })()

  /**
   * 处理下一个待处理任务
   */
  private async processNextTask(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('Task is already processing, skipping this poll')
      return
    }

    this.isProcessing = true

    try {
      const task = await this.getNextTask()
      if (!task) {
        this.logger.debug('No tasks to process at the moment')
        return
      }

      try {
        const { type } = task.payload

        switch (task.payload.type) {
          case 'user-deletion': {
            const { processUserDeletion } = await import('../users/deletion')
            if (!(await processUserDeletion(task.payload.userId))) { await this.releaseTaskToPending(task.id, { delayMs: 5000, priority: -2 }); return }
            break
          }
          case 'ownership-transfer':
          case 'ownership-transfer-cleanup': {
            const { processOwnershipTransfer } = await import('../photo-management/transfer')
            if (!(await processOwnershipTransfer(task.payload.transferId))) { await this.releaseTaskToPending(task.id, { delayMs: 5000, priority: -1 }); return }
            break
          }
          case 'photo-purge': {
            const { purgeRegisteredPhoto } = await import('../photo-management/purge')
            await purgeRegisteredPhoto(task.payload.photoId)
            break
          }
          case 'upload-cleanup': {
            const { cleanupUploadSession } = await import('../uploads/cleanup')
            await cleanupUploadSession(task.payload.uploadSessionId)
            break
          }
          case 'photo-process': {
            const { acquireUploadProcessor, releaseUploadProcessor, processUploadedPhoto } = await import('../uploads/process')
            if (!acquireUploadProcessor()) { await this.releaseTaskToPending(task.id, { delayMs: 1500, priority: -1 }); return }
            try { await processUploadedPhoto(task.payload.photoId) } finally { releaseUploadProcessor() }
            break
          }
          case 'live-photo-video':
            await this.processors.livePhotoDetect(task)
            break
          case 'photo': {
            const {acquireUploadProcessor,releaseUploadProcessor}=await import('../uploads/process')
            if(!acquireUploadProcessor()){await this.releaseTaskToPending(task.id,{delayMs:1500,priority:-1});return}
            try{await this.processors.photo(task)}finally{releaseUploadProcessor()}
            break
          }
          case 'photo-reverse-geocoding':
            await this.processors.reverseGeocoding(task)
            break
          case 'photo-erase-location':
            await this.processors.eraseLocation(task)
            break
          case 'library-file': {
            const { libraryScanner } = await import('../library/scanner')
            const outcome = await libraryScanner.processSingleFile(
              task.payload.mount,
              task.payload.libraryPath,
            )
            this.logger.success(
              `[${task.id}:library-file] ${outcome}: ${task.payload.mount}/${task.payload.libraryPath}`,
            )
            break
          }
          case 'photo-smart-search': {
            await this.updateTaskStage(task.id, 'smart-search')
            const { processSmartSearch } = await import('../ml/smart-search.service')
            await processSmartSearch((task.payload as any).photoId)
            break
          }
          case 'photo-face-detection': {
            await this.updateTaskStage(task.id, 'face-detection')
            const { processFaceDetection } = await import(
              '../ml/face-detection.service'
            )
            const facePayload = task.payload as {
              photoId: string
              reindexBatch?: boolean
            }
            await processFaceDetection(facePayload.photoId, {
              reindexBatch: facePayload.reindexBatch,
            })
            break
          }
          case 'photo-face-recognition': {
            await this.updateTaskStage(task.id, 'face-recognition')
            const { processFaceRecognition } = await import(
              '../ml/face-recognition.service'
            )
            const {
              tryAcquireRecognitionLock,
              releaseRecognitionLock,
            } = await import('../ml/recognition-lock')
            // Do not park this worker waiting on the lock — requeue and free the slot.
            if (!tryAcquireRecognitionLock()) {
              await this.releaseTaskToPending(task.id, {
                delayMs: 1500,
                priority: -1,
              })
              this.logger.debug(
                `[${this.workerId}] Recognition busy; requeued task ${task.id}`,
              )
              return
            }
            try {
              const p = task.payload as any
              await processFaceRecognition({
                faceId: p.faceId,
                deferred: p.deferred,
              })
            } finally {
              releaseRecognitionLock()
            }
            break
          }
          case 'photo-ocr': {
            await this.updateTaskStage(task.id, 'ocr')
            const { processOcr } = await import('../ml/ocr.service')
            await processOcr((task.payload as any).photoId)
            break
          }
          default:
            throw new Error(`Unknown task type: ${type}`)
        }

        await this.markTaskCompleted(task.id)
        this.processedCount++
        this.logger.success(
          `[${this.workerId}] Task ${task.id} processed successfully (Total: ${this.processedCount})`,
        )

        // const result = await this.processTask(task)
        // if (result) {
        //   await this.markTaskCompleted(task.id)
        //   this.processedCount++
        //   this.logger.success(
        //     `[${this.workerId}] Task ${task.id} processed successfully (Total: ${this.processedCount})`,
        //   )
        // } else {
        //   await this.markTaskFailed(task.id, 'Processing result is empty')
        //   this.errorCount++
        // }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        await this.markTaskFailed(task.id, errorMessage)
        this.errorCount++
        this.logger.error(
          `[${this.workerId}] Task ${task.id} processing failed (Error: ${this.errorCount}):`,
          errorMessage,
        )
      }
    } catch (error) {
      this.logger.error('Error occurred while fetching the next task:', error)
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * 开始处理队列
   * @param intervalMs 轮询间隔
   */
  startProcessing(intervalMs: number = 3000): void {
    if (this.processingInterval) return

    this.processingInterval = setInterval(() => {
      this.processNextTask().catch((error) => {
        this.logger.error('Error occurred while processing the queue:', error)
      })
    }, intervalMs)

    this.logger.success(
      `Queue processing started with interval: ${intervalMs}ms`,
    )

    this.processNextTask().catch((error) => {
      this.logger.error('Error occurred while processing the queue:', error)
    })
  }

  /**
   * 停止处理队列
   */
  stopProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval)
      this.processingInterval = null
      this.logger.warn('Queue processing stopped')
    }
  }

  /**
   * 获取队列统计信息
   * @returns 队列统计信息
   */
  async getQueueStats() {
    const db = useDB()
    const stats = await db
      .select({
        status: tables.pipelineQueue.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(tables.pipelineQueue)
      .groupBy(tables.pipelineQueue.status)

    return stats.reduce(
      (acc, stat) => {
        acc[stat.status] = stat.count
        return acc
      },
      {} as Record<string, number>,
    )
  }
}
