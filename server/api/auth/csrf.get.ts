import { randomBytes } from 'node:crypto'

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const token = session.csrfToken || randomBytes(32).toString('hex')
  if (!session.csrfToken) await setUserSession(event, { csrfToken: token })
  setHeader(event, 'Cache-Control', 'private, no-store')
  return { token }
})
