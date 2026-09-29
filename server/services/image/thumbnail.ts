import sharp from 'sharp'
import { generateBlurHash } from './blurhash'
import { withRetry, RetryPresets } from '../../utils/retry'

export interface ThumbnailOptions {
  /** 保留动画（GIF → animated webp），默认 false 取静态首帧 */
  animated?: boolean
  /** 缩略图目标宽度，默认 1280；动画缩略图建议更小以控制体积 */
  width?: number
}

export const generateThumbnailAndHash = async (
  buffer: Buffer,
  logger?: Logger[keyof Logger],
  options: ThumbnailOptions = {},
) => {
  return await withRetry(
    async () => {
      // GIF 动画缩略图：不 rotate（GIF 无 EXIF orientation），逐帧保留
      const sharpInst = options.animated
        ? sharp(buffer, { animated: true })
        : sharp(buffer).rotate()

      // 根据文件大小调整缩略图质量
      const fileSizeMB = buffer.length / (1024 * 1024)
      const quality = fileSizeMB > 5 ? 90 : 100

      const thumbnailBuffer = await sharpInst
        .resize(options.width ?? 1280, null, {
          withoutEnlargement: true,
          fastShrinkOnLoad: false, // 提高质量
        })
        .webp({ quality, animated: options.animated ?? false })
        .toBuffer()

      logger?.info(`Successfully generated thumbnail (quality: ${quality})`)

      // 生成BlurHash（动画取首帧）
      const thumbnailHash = await generateBlurHash(thumbnailBuffer, logger)

      return { thumbnailBuffer, thumbnailHash }
    },
    {
      ...RetryPresets.standard,
      timeout: 15000,
      delayStrategy: 'linear', // 图像处理适合线性退避
    },
    logger,
  )
}
