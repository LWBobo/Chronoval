/**
 * 面向访客和普通登录用户的照片 DTO。
 * 文件系统键、扫描库路径和后台处理状态只供管理端使用；前台通过受权限保护的
 * originalUrl/thumbnailUrl/livePhotoVideoUrl 访问媒体，不需要知道内部落盘位置。
 */
export function toPublicPhoto<T extends Record<string, any>>(photo: T, privileged = false) {
  const {
    storageKey: _storageKey,
    thumbnailKey: _thumbnailKey,
    livePhotoVideoKey: _livePhotoVideoKey,
    libraryPath: _libraryPath,
    libraryMount: _libraryMount,
    libraryId: _libraryId,
    faceScannedAt: _faceScannedAt,
    deletedAt: _deletedAt,
    ownerId: _ownerId,
    uploadedBy: _uploadedBy,
    uploadRelativePath: _uploadRelativePath,
    storageRelativePath: _storageRelativePath,
    originalFilename: _originalFilename,
    contentChecksum: _contentChecksum,
    originalBytes: _originalBytes,
    preserveOriginal: _preserveOriginal,
    processingStatus: _processingStatus,
    processingErrorCode: _processingErrorCode,
    transferState: _transferState,
    activeTransferId: _activeTransferId,
    moderationReason: _moderationReason,
    aclVersion: _aclVersion,
    metadataVersion: _metadataVersion,
    ...safe
  } = photo
  if (photo.stripLocation && !privileged) {
    return { ...safe, latitude: null, longitude: null, country: null, city: null, locationName: null, exif: photo.exif ? Object.fromEntries(Object.entries(photo.exif).filter(([key]) => !key.startsWith('GPS'))) : null }
  }
  return safe
}
