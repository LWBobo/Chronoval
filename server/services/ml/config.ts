import { settingsManager } from '../settings/settingsManager'

async function bool(ns: string, key: string, fallback: boolean): Promise<boolean> {
  try {
    const v = await settingsManager.get<boolean>(ns as any, key as any)
    if (typeof v === 'boolean') return v
  } catch {
    /* ignore */
  }
  return fallback
}

async function num(ns: string, key: string, fallback: number): Promise<number> {
  try {
    const v = await settingsManager.get<number>(ns as any, key as any)
    if (typeof v === 'number' && !Number.isNaN(v)) return v
  } catch {
    /* ignore */
  }
  return fallback
}

export async function isMlEnabled() {
  return bool('ml', 'enabled', true)
}

export async function isClipEnabled() {
  return (await isMlEnabled()) && bool('ml', 'clip.enabled', true)
}

export async function isFaceEnabled() {
  return (await isMlEnabled()) && bool('ml', 'face.enabled', true)
}

export async function isOcrEnabled() {
  return (await isMlEnabled()) && bool('ml', 'ocr.enabled', true)
}

export async function faceMinScore() {
  return num('ml', 'face.minScore', 0.7)
}

export async function faceMaxDistance() {
  return num('ml', 'face.maxDistance', 0.5)
}

export async function faceMinFaces() {
  return num('ml', 'face.minFaces', 3)
}

export async function clipTopK() {
  return num('ml', 'clip.topK', 50)
}

/** Minimum cosine similarity kept for description search. */
export async function clipMinScore() {
  const value = await num('ml', 'clip.minScore', 0.2)
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

async function str(ns: string, key: string, fallback: string): Promise<string> {
  try {
    const v = await settingsManager.get<string>(ns as any, key as any)
    if (typeof v === 'string' && v.trim()) return v.trim()
  } catch {
    /* ignore */
  }
  return fallback
}

/** Sidecar CLIP id, e.g. `ViT-L-14/chinese-clip`. */
export async function clipModel() {
  return str('ml', 'clip.model', 'fnos/img2vec-large-1.0.0')
}

/** InsightFace pack name sent to the sidecar, e.g. `buffalo_l`. */
export async function faceModel() {
  return str('ml', 'face.model', 'buffalo_l')
}
