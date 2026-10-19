import { addProtocol } from 'maplibre-gl'
import { Protocol } from 'pmtiles'

/**
 * Register the pmtiles:// protocol on the same maplibre-gl instance the
 * map components use. Must run before the first map is created.
 */
export default defineNuxtPlugin(() => {
  const protocol = new Protocol()
  try {
    addProtocol('pmtiles', protocol.tile)
  } catch {
    // The protocol is already registered after a hot reload.
  }
})
