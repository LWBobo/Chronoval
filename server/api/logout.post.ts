export default defineEventHandler(async (event) => {
  await clearUserSession(event)
  for (const name of Object.keys(parseCookies(event))) {
    if (/^(?:album_|scan_album_|collection_unlock_)/.test(name)) deleteCookie(event, name, { path: '/' })
  }
  return { success: true }
})
