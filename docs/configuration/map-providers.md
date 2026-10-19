# Map Providers

Chronoval supports three map providers. You can choose the one that best fits your needs.

| Provider              | Supported | Extra Configuration   | Features                                     |
| --------------------- | :-------: | --------------------- | -------------------------------------------- |
| [MapLibre](#maplibre)   |    ✅     | MapTiler Access Token | Free and open-source, supports custom styles |
| [Mapbox](#mapbox)       |    ✅     | Mapbox Access Token   | Free tier, better renderer performance       |
| [Protomaps](#protomaps) |    ✅     | Local PMTiles file    | No map API key                               |

## MapLibre

To use MapLibre as the map provider, you need a [MapTiler Access Token](https://cloud.maptiler.com/account/keys/).

```bash
NUXT_PUBLIC_MAP_PROVIDER=maplibre
NUXT_PUBLIC_MAP_MAPLIBRE_TOKEN=your_maplibre_access_token
```

### Custom Styles

```bash
# Chronoval comes with built-in light and dark styles that switch automatically.
# If you configure a custom style, it will override the default styles.
# Example: https://demotiles.maplibre.org/globe.json
NUXT_PUBLIC_MAP_MAPLIBRE_STYLE=
```

## Mapbox

To use Mapbox as the map provider, you will need a [Mapbox Access Token](https://console.mapbox.com/account/access-tokens/).

```bash
NUXT_PUBLIC_MAP_PROVIDER=mapbox
NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN=your_mapbox_access_token
```

### Custom Styles

```bash
# If you configure a custom style, it will override the default styles.
# Example: mapbox://styles/mapbox/streets-v11
NUXT_PUBLIC_MAP_MAPBOX_STYLE=
```

## Protomaps

Mount `20261018.pmtiles` at `/app/map/20261018.pmtiles` inside the container, then select Protomaps in map settings. Labels follow the interface language (`zh-Hans` or `zh-Hant` for Chinese). No MapTiler or Mapbox key is required.

The file name can be changed in settings, but the archive must stay inside `/app/map` and end with `.pmtiles`.
