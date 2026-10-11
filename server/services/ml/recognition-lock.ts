/**
 * Ensure face-recognition jobs never run concurrently (Immich-style).
 * Non-blocking: callers should requeue when the lock is busy instead of
 * parking a pipeline worker in a wait queue.
 */
let locked = false

/** @returns true if the lock was acquired. */
export function tryAcquireRecognitionLock(): boolean {
  if (locked) return false
  locked = true
  return true
}

export function releaseRecognitionLock(): void {
  locked = false
}

/** @deprecated Prefer tryAcquire / release so workers are not blocked. */
export async function withRecognitionLock<T>(fn: () => Promise<T>): Promise<T> {
  while (!tryAcquireRecognitionLock()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  try {
    return await fn()
  } finally {
    releaseRecognitionLock()
  }
}
