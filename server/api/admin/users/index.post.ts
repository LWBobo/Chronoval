import { createAccount, createUserSchema } from '../../../services/users'
export default defineEventHandler(async (event) => {
  const actor = await requireAccess(event, 'admin')
  const input = await readValidatedBody(event, createUserSchema.parse)
  const result = await createAccount(input, actor.user!.id, 'user', actor)
  setResponseStatus(event, 201)
  return result
})
