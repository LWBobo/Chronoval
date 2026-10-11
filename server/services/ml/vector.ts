/** Float32 embedding helpers (L2-normalized cosine distance). */

export function bufferToFloat32(buf: Buffer | Uint8Array): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(ab)
}

export function float32ToBuffer(arr: number[] | Float32Array): Buffer {
  const f =
    arr instanceof Float32Array ? arr : Float32Array.from(arr)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

/** Cosine distance for L2-normalized vectors: 0 = identical, 2 = opposite. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!
  return Math.max(0, 1 - dot)
}

export function iou(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): number {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter <= 0) return 0
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1)
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
  const uni = areaA + areaB - inter
  return uni > 0 ? inter / uni : 0
}
