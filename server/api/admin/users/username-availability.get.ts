import { normalizeUsername } from '../../../utils/identity'
export default defineEventHandler(async event => {
  await requireAccess(event, 'admin')
  try {
    const username = normalizeUsername(String(getQuery(event).username ?? ''))
    const existing = useDB().select({ id: tables.users.id }).from(tables.users).where(eq(tables.users.usernameKey, username)).get()
    return { username, valid: true, available: !existing }
  } catch (error: any) {
    if (error.statusCode) throw error
    return { valid: false, available: false, message: '用户名需为 3–32 位字母、数字、下划线或连字符，并以字母开头' }
  }
})
