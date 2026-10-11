/**
 * Cap ML inference concurrency without shrinking the shared thumbnail worker pool.
 * CPU default: CLIP 1, face detection 1, OCR 2. Face clustering stays on recognition-lock.
 */
function createLimiter(max: number) {
  let active = 0
  const waiters: Array<() => void> = []

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      const next = waiters.shift()
      next?.()
    }
  }
}

export const withClipLimit = createLimiter(1)
export const withFaceDetectLimit = createLimiter(1)
export const withOcrLimit = createLimiter(2)
