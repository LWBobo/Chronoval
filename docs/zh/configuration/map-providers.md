# 地图提供器

Chronoval 支持三种地图提供器，您可以根据需求选择合适的提供器。

| 提供器                | 支持 | 额外配置          | 特性                     |
| --------------------- | :--: | ----------------- | ------------------------ |
| [MapLibre](#maplibre)   |  ✅  | MapTiler 访问令牌 | 免费开源，支持自定义样式 |
| [Mapbox](#mapbox)       |  ✅  | MapBox 访问令牌   | 免费用量，更好的渲染器   |
| [Protomaps](#protomaps) |  ✅  | 本地 PMTiles 文件 | 不需要地图 API key       |

## MapLibre

要使用 MapLibre 作为地图提供器，您需要一个 [MapTiler 访问令牌](https://cloud.maptiler.com/account/keys/)。

```bash
NUXT_PUBLIC_MAP_PROVIDER=maplibre
NUXT_PUBLIC_MAP_MAPLIBRE_TOKEN=your_maplibre_access_token
```

### 自定义样式

```bash
# Chronoval 已经内置了自动切换的浅色和深色两种样式
# 如果配置自定义样式，将会覆盖默认样式
# 示例: https://demotiles.maplibre.org/globe.json
NUXT_PUBLIC_MAP_MAPLIBRE_STYLE=
```

## MapBox

要使用 Mapbox 作为地图提供器，您需要一个 [Mapbox 访问令牌](https://console.mapbox.com/account/access-tokens/)。

```bash
NUXT_PUBLIC_MAP_PROVIDER=mapbox
NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN=your_mapbox_access_token
```

### 自定义样式

```bash
# 如果配置自定义样式，将会覆盖默认样式
# 示例: mapbox://styles/mapbox/streets-v11
NUXT_PUBLIC_MAP_MAPBOX_STYLE=
```

## Protomaps

把 `20261018.pmtiles` 挂到容器内的 `/app/map/20261018.pmtiles`，然后在地图设置里选择 Protomaps。界面语言为简体中文时，地名使用 `zh-Hans`；繁体界面使用 `zh-Hant`。不需要 MapTiler 或 Mapbox 的 key。

文件名可以在设置里改，但必须仍是 `/app/map` 目录下的 `.pmtiles` 文件。

### 区域包（可选）

全球 Planet 体积很大时，可用官方 CLI 裁切感兴趣区域，再挂载区域文件：

```bash
pmtiles extract planet.pmtiles region.pmtiles --bbox=minLon,minLat,maxLon,maxLat
```

把 `region.pmtiles` 放到 `/app/map`，在设置里把 `protomaps.file` 改为该文件名即可，无需改代码。Chronoval 会在同进程内对 `/map/pmtiles` 的 Range 做内存/磁盘缓存（见 `CHRONOVAL_PMTILES_CACHE_*`），不新增旁路服务。
