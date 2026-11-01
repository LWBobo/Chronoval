import { z } from 'zod'
import { changeTwoFactor } from '../../../services/users/two-factor'

export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'user')
  const { code } = await readValidatedBody(
    event,
    z.object({ code: z.string().min(1).max(8) }).parse,
  )
  assertRateLimit(event, {
    namespace: 'account-2fa-disable',
    subject: String(actor.user!.id),
    limit: 10,
    windowMs: 10 * 60 * 1000,
  })
  const next = changeTwoFactor(actor, code, false)
  await establishUserSession(event, next)
  return { enabled: false }
})
