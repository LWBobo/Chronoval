import { listScanLibraries } from '~~/server/services/scan-library/manager'

export default eventHandler(async () => {
  const libs = await listScanLibraries()
  return { libraries: libs }
})
