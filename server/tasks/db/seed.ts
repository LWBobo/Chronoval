import { createAccount, createUserSchema } from '../../services/users'
export default defineTask({
  meta: { name: 'db:seed', description: 'Create the explicitly configured initial administrator' },
  async run() {
    if (useDB().select({ id: tables.users.id }).from(tables.users).limit(1).get()) return { result: 'already-initialized' }
    if (!process.env.CFRAME_ADMIN_PASSWORD) return { result: 'wizard-required' }
    const input = createUserSchema.parse({ username: process.env.CFRAME_ADMIN_NAME || 'chronoframe', email: process.env.CFRAME_ADMIN_EMAIL || 'admin@chronoframe.com', password: process.env.CFRAME_ADMIN_PASSWORD, quotaBytes: null })
    await createAccount(input, null, 'admin')
    return { result: 'success' }
  },
})
