import { sql, type AnyColumn } from 'drizzle-orm'

/** 与扫描入库时一致：编码文件名中的中文、空格、百分号等，保留目录分隔符。 */
export function libraryMediaPath(mountName: string, relativePath: string) {
  return `/library/${mountName}/${encodeURIComponent(relativePath).replace(/%2F/g, '/')}`
}

/** 精确匹配媒体路径，只允许附带查询参数；文件名中的 % 和 _ 不是通配符。 */
export function mediaUrlPathMatches(column: AnyColumn, pathname: string) {
  return sql`(
    ${column} = ${pathname}
    OR instr(${column}, ${`${pathname}?`}) = 1
  )`
}
