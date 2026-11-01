export const collectionVisibilities = ['public', 'login', 'selected', 'admin'] as const
export type CollectionVisibility = typeof collectionVisibilities[number]
export type PhotoVisibility = 'private' | 'public' | 'shared'
export type OwnershipType = 'site' | 'user'
export interface PermissionActor {
  user: { id: number; role?: 'admin' | 'user'; authVersion?: number } | null
  isAdmin: boolean
}
export interface CollectionAccessInput {
  expectedAclVersion: number
  visibility: CollectionVisibility
  viewerIds: number[]
  passwordAction: 'keep' | 'set' | 'clear'
  newPassword?: string
  passwordExemptMode: 'none' | 'logged_in' | 'selected'
  passwordExemptUserIds: number[]
  reason: string
}
