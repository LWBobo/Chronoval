import type { SessionUser } from '../../server/utils/auth'

declare module '#auth-utils' {
  interface User extends SessionUser {}
  interface UserSession { csrfToken?: string }
}

export {}
