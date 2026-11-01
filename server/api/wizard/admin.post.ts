import { createAccount, createUserSchema } from '../../services/users'

export default eventHandler(async (event) => {
  const input = await readValidatedBody(event, createUserSchema.parse)
  if (useDB().select({ id: tables.users.id }).from(tables.users).limit(1).get()) {
    throw createError({ statusCode: 409, message: '初始管理员已创建，请继续完成向导' })
  }
  const { user } = await createAccount({ ...input, quotaBytes: null }, null, 'admin')
  return { success: true, user }
})
