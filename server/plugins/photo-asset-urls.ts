import { withPhotoAssetUrls } from '../utils/asset-reference'

/** Apply playback aliases at the API boundary, including admin and nested album results. */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event, response) => {
    const pathname = getRequestURL(event).pathname
    if (
      !/^\/api\/(?:photos|albums|map\/photos|people|search|picker|trash)(?:\/|$)/.test(
        pathname,
      )
    )
      return
    response.body = withPhotoAssetUrls(response.body)
  })
})
