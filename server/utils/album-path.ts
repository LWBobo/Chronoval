/** 输入已经由路由或查询参数解析器解码；保留文件名中的字面量 %，禁止再次解码。 */
export function normalizeAlbumPath(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  if (
    parts.some(
      (part) =>
        part === '.' ||
        part === '..' ||
        Array.from(part).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ),
    )
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid album path' })
  }
  return parts.join('/')
}
