/**
 * HTTP client for chronoval-ml sidecar.
 * Endpoints: /ping, /v1/clip/image, /v1/clip/text, /v1/faces, /v1/ocr
 */
import { settingsManager } from '../settings/settingsManager'

export class MlUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MlUnavailableError'
  }
}

export interface ClipEmbeddingResult {
  embedding: number[]
  dim: number
  model: string
}

export interface DetectedFace {
  bbox: { x1: number; y1: number; x2: number; y2: number }
  score: number
  embedding: number[]
}

export interface OcrBlock {
  text: string
  confidence: number
  bbox: [number, number, number, number]
}

export interface OcrResult {
  text: string
  blocks: OcrBlock[]
}

async function mlBaseUrl(): Promise<string> {
  try {
    const fromSettings = await settingsManager.get<string>('ml' as any, 'url' as any)
    if (fromSettings && String(fromSettings).trim()) {
      return String(fromSettings).replace(/\/$/, '')
    }
  } catch {
    // settings may not be ready
  }
  return (
    process.env.CHRONOVAL_ML_URL ||
    process.env.NUXT_CHRONOVAL_ML_URL ||
    'http://127.0.0.1:3003'
  ).replace(/\/$/, '')
}

function toBlob(image: Buffer, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(image)], { type })
}

async function postForm(
  path: string,
  form: FormData,
  timeoutMs = 120_000,
): Promise<any> {
  const url = `${await mlBaseUrl()}${path}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: ctrl.signal })
    if (res.status === 503) {
      const body = await res.text().catch(() => '')
      throw new MlUnavailableError(`ML model unavailable: ${body}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ML ${path} failed (${res.status}): ${body}`)
    }
    return await res.json()
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new MlUnavailableError(`ML timeout: ${path}`)
    }
    if (err instanceof MlUnavailableError) throw err
    throw new MlUnavailableError(
      `ML unreachable (${url}): ${err?.message || err}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function postJson(path: string, body: unknown, timeoutMs = 60_000): Promise<any> {
  const url = `${await mlBaseUrl()}${path}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (res.status === 503) {
      throw new MlUnavailableError(`ML model unavailable: ${await res.text()}`)
    }
    if (!res.ok) {
      throw new Error(`ML ${path} failed (${res.status}): ${await res.text()}`)
    }
    return await res.json()
  } catch (err: any) {
    if (err instanceof MlUnavailableError) throw err
    throw new MlUnavailableError(
      `ML unreachable (${url}): ${err?.message || err}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function pingMl(): Promise<boolean> {
  try {
    const res = await fetch(`${await mlBaseUrl()}/ping`, {
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function encodeImage(
  image: Buffer,
  filename = 'image.jpg',
  model?: string,
): Promise<ClipEmbeddingResult> {
  const form = new FormData()
  form.append('image', toBlob(image), filename)
  if (model) form.append('model', model)
  const data = await postForm('/v1/clip/image', form)
  return {
    embedding: data.embedding,
    dim: data.dim,
    model: data.model,
  }
}

export async function encodeText(
  text: string,
  model?: string,
): Promise<ClipEmbeddingResult> {
  const data = await postJson('/v1/clip/text', { text, model })
  return {
    embedding: data.embedding,
    dim: data.dim,
    model: data.model,
  }
}

export async function detectFaces(
  image: Buffer,
  minScore = 0.7,
  filename = 'image.jpg',
  model?: string,
): Promise<{ faces: DetectedFace[]; width: number; height: number }> {
  const form = new FormData()
  form.append('image', toBlob(image), filename)
  form.append('min_score', String(minScore))
  if (model) form.append('model', model)
  const data = await postForm('/v1/faces', form, 180_000)
  return {
    faces: data.faces || [],
    width: data.width || 0,
    height: data.height || 0,
  }
}

export async function runOcr(
  image: Buffer,
  filename = 'image.jpg',
): Promise<OcrResult> {
  const form = new FormData()
  form.append('image', toBlob(image), filename)
  const data = await postForm('/v1/ocr', form, 120_000)
  return {
    text: data.text || '',
    blocks: data.blocks || [],
  }
}
