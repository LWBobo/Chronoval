import { listScanLibraries } from '~~/server/services/scan-library/manager'

export default eventHandler(async (event) => {
  const libs = await listScanLibraries()
  return { libraries: libs }
})