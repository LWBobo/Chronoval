import { z } from 'zod'
import { scanMountName } from '~~/server/services/scan-library/manager'
import {
  upsertScanAlbumMeta,
  clearScanAlbumMeta,
} from '~~/server/services/scan-library/album-meta'
import { collectionAccessSchema } from '../../services/collections/access'
import { assertCurrentActor } from '../../services/users'
import { parseExemptUsers } from '~~/server/utils/albumPasswordExempt'

/**
 * 新增/更新/清除某扫描库相簿（或其二级子相簿）的元数据。
 * 仅管理员可访问。用于外部库相簿的标题、介绍、封面、隐藏、自定义URL 编辑。
 */
export default eventHandler(async (event) => {

  const actor = await requireAccess(event, 'admin')
  const body = await readValidatedBody(
    event,
    z.object({
      libId: z.number().int().positive(),
      // 目录相对路径：'' 表示库根（主相簿）
      path: z.string().default(''),
      title: z.string().max(255).nullable().optional(),
      description: z.string().max(1000).nullable().optional(),
      coverPhotoId: z.string().nullable().optional(),
      access: collectionAccessSchema.optional(),
      slug: z
        .string()
        .max(120)
        .nullable()
        .optional()
        .transform((v) => (v ? v.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : v)),
      // 照片展示布局：瀑布流 / 统一网格 / 沉浸式看图
      layout: z.enum(['waterfall', 'grid', 'immersive', 'timeline']).optional(),
      // 「随机一张照片」动画模式：default=直接打开 / wheel=3D轮盘 / compat=兼容动画
      randomAnimation: z.enum(['default', 'wheel', 'compat']).optional(),
      // 「随机一张照片」是否使用 3D 轮盘动画（旧字段，兼容旧客户端）
      randomWheelAnimation: z.boolean().optional(),
      // 「随机照片轮经典语录」扩展功能是否开启
      randomQuotesEnabled: z.boolean().optional(),
      // 自定义语录（每行一条）；空=使用内置语录
      randomQuotes: z.string().max(5000).nullable().optional(),
      // 「随机照片轮经典语录」标签来源：ancient=古诗语录 / modern=现代语录；null=未选（使用自定义）
      randomQuotesTag: z.enum(['ancient', 'modern']).nullable().optional(),
      // 相簿背景音乐（音乐盒）；null=不播放 BGM
      bgmMusicId: z.number().int().nullable().optional(),
      // 传 true 时清除该相簿的元数据（还原为默认推导值）
      clear: z.boolean().optional(),
    }).strict().refine(value => !value.clear || !value.access, '清除展示配置与修改权限须分别提交').parse,
  )

  const mount = scanMountName(body.libId)

  if (body.clear) {
    await clearScanAlbumMeta(mount, body.path)
    return { success: true, cleared: true }
  }

  const meta = useDB().transaction((tx) => {
    assertCurrentActor(tx as any, actor, true)
    return upsertScanAlbumMeta({
    mount,
    access: body.access,
    relPath: body.path,
    title: body.title,
    description: body.description,
    coverPhotoId: body.coverPhotoId,
    slug: body.slug,
    layout: body.layout,
    randomWheelAnimation: body.randomWheelAnimation,
    randomAnimation: body.randomAnimation,
    randomQuotesEnabled: body.randomQuotesEnabled,
    randomQuotes: body.randomQuotes,
    randomQuotesTag: body.randomQuotesTag,
    bgmMusicId: body.bgmMusicId,
    }, actor)
  }, { behavior: 'immediate' })

  return {
    success: true,
    meta: {
      mount: meta.mount,
      relPath: meta.relPath,
      title: meta.title,
      description: meta.description,
      coverPhotoId: meta.coverPhotoId,
      isHidden: meta.isHidden,
      passwordProtected: Boolean(meta.passwordHash),
      passwordExemptMode: meta.passwordExemptMode ?? null,
      passwordExemptUsers: parseExemptUsers(meta.passwordExemptUsers),
      slug: meta.slug,
      layout: meta.layout,
      randomWheelAnimation: meta.randomWheelAnimation,
      randomAnimation: meta.randomAnimation,
      randomQuotesEnabled: meta.randomQuotesEnabled,
      randomQuotes: meta.randomQuotes,
      randomQuotesTag: meta.randomQuotesTag,
    },
  }
})
