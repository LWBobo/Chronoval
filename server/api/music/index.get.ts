import { listMusic, serializeMusic } from '~~/server/services/music'

/**
 * 列出音乐盒中全部 BGM。仅管理员可访问。
 */
export default eventHandler(async (event) => {

  const rows = await listMusic()
  return rows.map(serializeMusic)
})