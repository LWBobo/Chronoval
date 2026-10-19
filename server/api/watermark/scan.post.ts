import { scanMountedWatermarks } from '~~/server/services/image/watermark-library'

export default defineEventHandler(async () => {
  return await scanMountedWatermarks()
})
