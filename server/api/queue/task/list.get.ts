import { z } from 'zod'
import { desc, sql, eq, and, count, type SQL } from 'drizzle-orm'

const TASK_TYPES = [
  'photo',
  'live-photo-video',
  'photo-reverse-geocoding',
  'photo-erase-location',
  'photo-smart-search',
  'photo-face-detection',
  'photo-face-recognition',
  'photo-ocr',
] as const

/**
 * 获取队列任务列表（分页，默认最近 100 条，避免全表拖死后台页）
 */
export default defineEventHandler(async (event) => {
  await requireUserSession(event)

  try {
    const query = getQuery(event)
    const {
      status,
      type,
      limit: rawLimit,
      offset: rawOffset,
    } = await z
      .object({
        status: z
          .enum(['pending', 'in-stages', 'completed', 'failed'])
          .optional(),
        type: z.enum(TASK_TYPES).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parseAsync(query)

    const limit = rawLimit ?? 100
    const offset = rawOffset ?? 0
    const db = useDB()

    const typeCondition = type
      ? eq(sql`json_extract(${tables.pipelineQueue.payload}, '$.type')`, type)
      : undefined

    const listConditions: SQL[] = []
    if (status) {
      listConditions.push(eq(tables.pipelineQueue.status, status))
    }
    if (typeCondition) {
      listConditions.push(typeCondition)
    }
    const listWhere =
      listConditions.length > 0 ? and(...listConditions) : undefined

    const totalRow = db
      .select({ total: count() })
      .from(tables.pipelineQueue)
      .where(listWhere)
      .get()
    const total = Number(totalRow?.total || 0)

    const tasks = db
      .select({
        id: tables.pipelineQueue.id,
        payload: tables.pipelineQueue.payload,
        priority: tables.pipelineQueue.priority,
        attempts: tables.pipelineQueue.attempts,
        maxAttempts: tables.pipelineQueue.maxAttempts,
        status: tables.pipelineQueue.status,
        statusStage: tables.pipelineQueue.statusStage,
        errorMessage: tables.pipelineQueue.errorMessage,
        createdAt: tables.pipelineQueue.createdAt,
        completedAt: tables.pipelineQueue.completedAt,
      })
      .from(tables.pipelineQueue)
      .where(listWhere)
      .orderBy(desc(tables.pipelineQueue.createdAt))
      .limit(limit)
      .offset(offset)
      .all()

    // 状态卡片统计：不受 status 筛选影响，仅随 type 筛选变化
    const statusRows = db
      .select({
        status: tables.pipelineQueue.status,
        n: count(),
      })
      .from(tables.pipelineQueue)
      .where(typeCondition)
      .groupBy(tables.pipelineQueue.status)
      .all()

    const statusCounts = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    }
    for (const row of statusRows) {
      if (row.status === 'pending') statusCounts.pending = Number(row.n)
      else if (row.status === 'in-stages')
        statusCounts.processing = Number(row.n)
      else if (row.status === 'completed') statusCounts.completed = Number(row.n)
      else if (row.status === 'failed') statusCounts.failed = Number(row.n)
    }

    return {
      success: true,
      data: tasks,
      total,
      limit,
      offset,
      statusCounts,
    }
  } catch (error) {
    console.error('Failed to fetch task list:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch task list',
    })
  }
})
