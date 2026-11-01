import { settingsManager } from '../settings/settingsManager'

export const MAX_UPLOAD_BYTES = 256 * 1024 ** 2
export const MAX_IMAGE_BYTES = 100 * 1024 ** 2

export async function managedUploadLimits() {
  const configured = await settingsManager.get<number>('system', 'upload.maxFileSize')
  const maxFileBytes = Math.min(MAX_UPLOAD_BYTES, Number.isFinite(configured) && Number(configured) > 0 ? Number(configured) * 1024 ** 2 : MAX_UPLOAD_BYTES)
  return { maxFileBytes, maxImageBytes: Math.min(MAX_IMAGE_BYTES, maxFileBytes) }
}
