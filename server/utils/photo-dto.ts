/**
 * 面向访客和普通登录用户的照片 DTO。
 * 文件系统键、扫描库路径和后台处理状态只供管理端使用；前台通过受权限保护的
 * originalUrl/thumbnailUrl/livePhotoVideoUrl 访问媒体，不需要知道内部落盘位置。
 */
export function toPublicPhoto<T extends Record<string, any>>(photo: T) {
  const {
    storageKey: _storageKey,
    thumbnailKey: _thumbnailKey,
    livePhotoVideoKey: _livePhotoVideoKey,
    libraryPath: _libraryPath,
    libraryMount: _libraryMount,
    libraryId: _libraryId,
    faceScannedAt: _faceScannedAt,
    deletedAt: _deletedAt,
    ...safe
  } = photo
  return safe
}
