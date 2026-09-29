import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileP = promisify(execFile)

export interface VideoProbeInfo {
  width: number
  height: number
  duration: number
  hasVideo: boolean
}

export const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
export const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe'

/**
 * 使用 ffprobe 读取视频元数据（分辨率、时长）
 */
export const probeVideo = async (filePath: string): Promise<VideoProbeInfo | null> => {
  try {
    const { stdout } = await execFileP(
      FFPROBE_BIN,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,duration:format=duration',
        '-of', 'json',
        filePath,
      ],
      { timeout: 15000 },
    )
    const data = JSON.parse(stdout)
    const stream = data?.streams?.[0]
    if (!stream) {
      return { width: 0, height: 0, duration: 0, hasVideo: false }
    }
    const duration = Number(stream.duration || data?.format?.duration || 0) || 0
    return {
      width: Number(stream.width || 0),
      height: Number(stream.height || 0),
      duration,
      hasVideo: true,
    }
  } catch (err) {
    const e = err as Error
    // ffprobe 不存在或该文件不是有效视频
    if (String(e?.message).includes('ENOENT')) {
      logger.dynamic('library')?.warn?.('ffprobe not found at', FFPROBE_BIN)
    }
    return null
  }
}

/**
 * 使用 ffmpeg 抽取视频某一帧生成 JPG，用于缩略图
 * 依次尝试 25% 处、10% 处、1 秒处、0.1 秒处，任意一次成功即返回，提高各种格式/编码下的成功率。
 */
export const extractVideoFrame = async (
  filePath: string,
  durationSec: number,
): Promise<Buffer | null> => {
  // 候选时间点：优先中后段（画面更丰富），抽帧失败则逐步回退到片头附近
  const candidates =
    durationSec > 5
      ? [
          Math.min(durationSec * 0.25, 5),
          Math.max(durationSec * 0.1, 1),
          1,
          0.1,
        ]
      : [0.1]

  for (const time of candidates) {
    const args = [
      '-v', 'error',
      '-ss', String(Math.max(time, 0)),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=600:-1',
      '-q:v', '3',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ]
    try {
      const { stdout } = await execFileP(FFMPEG_BIN, args, {
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      })
      if (stdout && stdout.length > 0) {
        return Buffer.from(stdout)
      }
    } catch (err) {
      const e = err as Error
      if (String(e?.message).includes('ENOENT')) {
        logger.dynamic('library')?.warn?.('ffmpeg not found at', FFMPEG_BIN)
        return null
      }
      // 当前时间点抽帧失败，尝试下一个候选时间点
    }
  }
  return null
}

export const getVideoExtensionFromPath = (filePath: string): string =>
  path.extname(filePath).toLowerCase()

/**
 * 使用 ffprobe 读取音频时长（秒）。用于音乐盒上传时记录 BGM 时长。
 * 失败（文件头损坏 / ffprobe 缺失）时返回 null。
 */
export const probeAudioDuration = async (
  filePath: string,
): Promise<number | null> => {
  try {
    const { stdout } = await execFileP(
      FFPROBE_BIN,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 15000 },
    )
    const duration = Number((stdout || '').trim())
    return Number.isFinite(duration) && duration > 0 ? duration : null
  } catch {
    return null
  }
}