// Test-only boundaries: settings, filesystem mounts and the scan index. Authorization is real.
import { and, eq, or, inArray } from 'drizzle-orm'
import * as schema from '../../server/database/schema.ts'
export const tables = schema
export { and, eq, or, inArray }
const state = () => globalThis.__chronovalSecurityTest
export const useDB = () => state().db
export const getStorageManager = () => ({ getProvider: () => state().provider })
export const settingsManager = {
  get: async (namespace, key, fallback) =>
    state().settings.get(`${namespace}:${key}`) ?? fallback,
}
export const getLibraryMounts = () => state().mounts
export const getScanLibraryByKey = (key) =>
  state().libraries.find((lib) => String(lib.id) === key || lib.urlKey === key)
export const getScanAlbumDetail = async (libraryId, relPath) =>
  state().scanDetail ??
  state().actualManager.getScanAlbumDetail(libraryId, relPath)
export const listScanAlbumRoots = async () => state().scanRoots
export const getDisabledScanMountSet = () =>
  new Set(
    state()
      .libraries.filter((lib) => !lib.enabled)
      .map((lib) => `scan_${lib.id}`),
  )
export const getGalleryHiddenScanMountSet = () =>
  new Set(
    state()
      .libraries.filter((lib) => !lib.enabled || lib.displayMode === 'album')
      .map((lib) => `scan_${lib.id}`),
  )
export const getScanAlbumEffectiveAuth = async (libraryId, relPath) =>
  state().actualManager
    ? state().actualManager.getScanAlbumEffectiveAuth(libraryId, relPath)
    : (state().scanAuth.get(`${libraryId}:${relPath}`) ?? {
        passwordHash: null,
        exemptMode: null,
        exemptUsers: [],
      })
export const getScanAlbumEffectiveVisibility = (libraryId, relPath) =>
  state().actualManager
    ? state().actualManager.getScanAlbumEffectiveVisibility(libraryId, relPath)
    : (state().scanVisibility.get(`${libraryId}:${relPath}`) ?? 'public')

export const loadPhotoImageBuffer = async () => ({
  buffer: state().photoImage,
  filename: 'test.jpg',
})

export const logger = { chrono: { info() {}, warn() {}, error() {} } }

export const getGlobalStorageManager = getStorageManager
