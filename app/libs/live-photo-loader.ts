export interface LivePhotoProcessingState {
  isProcessing: boolean
  progress: number
  mp4Blob: Blob | null
  error: string | null
  lastProcessed: number
}

interface Entry {
  id: string
  url: string
  state: LivePhotoProcessingState
  controller: AbortController
  promise: Promise<Blob | null>
  resolve: (blob: Blob | null) => void
  background: boolean
  shouldRun?: () => boolean
}

/** 旧版的完整下载 → MP4 Blob 链路。不转码，不把网络 URL 直接交给 video。 */
export class LivePhotoLoader {
  private entries = new Map<string, Entry>()
  private queue: Entry[] = []
  private active = 0
  private backgroundActive = 0
  private fetcher: typeof fetch
  private onChange: () => void
  private timeoutMs: number
  private maxBytes: number
  private cacheBytes: number
  private cacheEntries: number
  private ttlMs: number
  private concurrency: number

  constructor(
    options: {
      fetch?: typeof fetch
      onChange?: () => void
      timeoutMs?: number
      maxBytes?: number
      cacheBytes?: number
      cacheEntries?: number
      ttlMs?: number
      concurrency?: number
    } = {},
  ) {
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args))
    this.onChange = options.onChange ?? (() => {})
    this.timeoutMs = options.timeoutMs ?? 90_000
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024
    this.cacheBytes = options.cacheBytes ?? 64 * 1024 * 1024
    this.cacheEntries = options.cacheEntries ?? 12
    this.ttlMs = options.ttlMs ?? 5 * 60_000
    this.concurrency = options.concurrency ?? 2
  }

  getState(id: string): LivePhotoProcessingState | null {
    const state = this.entries.get(id)?.state
    return state ? { ...state } : null
  }

  states() {
    return new Map(
      [...this.entries].map(([id, entry]) => [id, { ...entry.state }]),
    )
  }

  load(
    url: string,
    id: string,
    background = false,
    shouldRun?: () => boolean,
  ): Promise<Blob | null> {
    if (!url || !id) return Promise.resolve(null)
    this.prune()
    const existing = this.entries.get(id)
    if (existing?.url === url) {
      if (existing.state.isProcessing) {
        // 用户主动播放时，把尚未开始的后台任务提前。
        if (!background && this.queue.includes(existing)) {
          this.queue = this.queue.filter((entry) => entry !== existing)
          existing.background = false
          existing.shouldRun = undefined
          this.queue.unshift(existing)
        }
        return existing.promise
      }
      if (existing.state.mp4Blob) {
        existing.state.lastProcessed = Date.now()
        return Promise.resolve(existing.state.mp4Blob)
      }
    }
    if (existing) {
      existing.controller.abort()
      existing.resolve(null)
    }
    let resolve!: (blob: Blob | null) => void
    const promise = new Promise<Blob | null>((done) => {
      resolve = done
    })
    const entry: Entry = {
      id,
      url,
      promise,
      resolve,
      background,
      shouldRun,
      controller: new AbortController(),
      state: {
        isProcessing: true,
        progress: 0,
        mp4Blob: null,
        error: null,
        lastProcessed: Date.now(),
      },
    }
    this.entries.set(id, entry)
    if (background) this.queue.push(entry)
    else this.queue.unshift(entry)
    this.onChange()
    this.pump()
    return promise
  }

  private current(entry: Entry) {
    return (
      this.entries.get(entry.id) === entry && !entry.controller.signal.aborted
    )
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const index = this.queue.findIndex(
        (entry) => !entry.background || this.backgroundActive < 1,
      )
      if (index < 0) return
      const entry = this.queue.splice(index, 1)[0]!
      if (!this.current(entry)) {
        entry.resolve(null)
        continue
      }
      if (entry.background && entry.shouldRun && !entry.shouldRun()) {
        this.entries.delete(entry.id)
        entry.resolve(null)
        this.onChange()
        continue
      }
      this.active++
      if (entry.background) this.backgroundActive++
      void this.download(entry)
    }
  }

  private async download(entry: Entry) {
    let result: Blob | null = null
    // 覆盖整个响应体下载，而不只覆盖收到响应头之前。
    const timer = setTimeout(() => entry.controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(entry.url, {
        credentials: 'same-origin',
        cache: 'no-cache',
        signal: entry.controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`视频下载失败（HTTP ${response.status}）`)
      }
      const contentType = response.headers.get('content-type') || ''
      if (/^(text\/|application\/json)/i.test(contentType)) {
        await response.body?.cancel()
        throw new Error('视频接口返回了非视频内容')
      }
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > this.maxBytes) {
        await response.body?.cancel()
        throw new Error('动态照片视频过大')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('无法读取动态照片视频')
      const chunks: BlobPart[] = []
      let received = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!this.current(entry)) {
            await reader.cancel()
            return
          }
          received += value.byteLength
          if (received > this.maxBytes) {
            await reader.cancel()
            throw new Error('动态照片视频过大')
          }
          chunks.push(new Uint8Array(value))
          const progress =
            declared > 0
              ? Math.min(99, Math.floor((received / declared) * 100))
              : 0
          if (progress !== entry.state.progress) {
            entry.state.progress = progress
            this.onChange()
          }
        }
      } finally {
        reader.releaseLock()
      }
      if (!this.current(entry)) return
      if (!received) throw new Error('动态照片视频为空')
      const encoding = response.headers.get('content-encoding')
      if (
        declared > 0 &&
        (!encoding || encoding === 'identity') &&
        received !== declared
      ) {
        throw new Error('动态照片视频下载不完整')
      }
      result = new Blob(chunks, { type: 'video/mp4' })
      entry.state = {
        isProcessing: false,
        progress: 100,
        mp4Blob: result,
        error: null,
        lastProcessed: Date.now(),
      }
      this.onChange()
    } catch (error) {
      if (this.entries.get(entry.id) === entry) {
        entry.state.isProcessing = false
        entry.state.error = entry.controller.signal.aborted
          ? '动态照片加载已取消或超时，请重试'
          : error instanceof Error
            ? error.message
            : '动态照片加载失败'
        entry.state.lastProcessed = Date.now()
        this.onChange()
      }
    } finally {
      clearTimeout(timer)
      if (this.entries.get(entry.id) === entry && entry.state.isProcessing) {
        entry.state.isProcessing = false
        entry.state.error = '动态照片加载已取消或超时，请重试'
        this.onChange()
      }
      entry.resolve(this.current(entry) ? result : null)
      this.prune()
      this.active--
      if (entry.background) this.backgroundActive--
      this.pump()
    }
  }

  prune() {
    const ready = [...this.entries.values()]
      .filter((entry) => !entry.state.isProcessing)
      .sort((a, b) => a.state.lastProcessed - b.state.lastProcessed)
    let bytes = ready.reduce(
      (sum, entry) => sum + (entry.state.mp4Blob?.size || 0),
      0,
    )
    let count = ready.length
    let changed = false
    for (const entry of ready) {
      if (
        Date.now() - entry.state.lastProcessed <= this.ttlMs &&
        bytes <= this.cacheBytes &&
        count <= this.cacheEntries
      )
        continue
      bytes -= entry.state.mp4Blob?.size || 0
      count--
      this.entries.delete(entry.id)
      changed = true
    }
    if (changed) this.onChange()
  }

  clear() {
    for (const entry of this.entries.values()) {
      entry.controller.abort()
      entry.resolve(null)
    }
    this.entries.clear()
    this.queue = []
    this.onChange()
  }
}
