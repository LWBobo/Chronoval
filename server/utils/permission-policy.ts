import type { CollectionVisibility, PermissionActor } from '../../shared/types/permissions'

export function collectionAudienceAllows(
  actor: PermissionActor,
  visibility: CollectionVisibility | string,
  isViewer: boolean,
): boolean {
  if (!['public', 'login', 'selected', 'admin'].includes(visibility)) return false
  if (actor.isAdmin) return true
  if (visibility === 'public') return true
  if (visibility === 'login') return !!actor.user
  return visibility === 'selected' && !!actor.user && isViewer
}

export function personalPhotoAllows(
  actor: PermissionActor,
  photo: { ownerId: number | null; visibility: string; processingStatus: string; transferState: string; moderationStatus: string; deletedAt: unknown },
  facts: { shared: boolean; ownerActive: boolean; management?: boolean },
): boolean {
  if (facts.management && actor.isAdmin) return true
  if (photo.transferState === 'moving' || photo.processingStatus === 'purging') return false
  if (actor.user && actor.user.id === photo.ownerId) return true
  if (!facts.ownerActive || photo.processingStatus !== 'ready' || photo.deletedAt || photo.moderationStatus !== 'visible') return false
  return photo.visibility === 'public' || (!!actor.user && photo.visibility === 'shared' && facts.shared)
}
