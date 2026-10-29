# Protomaps basemap fonts & sprites

Vendored from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets)
so Chronoval can render map labels and icons without calling GitHub Pages
(intranet / offline / Docker).

Served by Nuxt as static files under `/map/basemaps-assets/…`.

- `fonts/` — SIL Open Font License (see upstream). Includes
  `Noto Sans Bold` as a copy of Medium (ChronoFrame MapLibre styles request Bold).
- `sprites/` — derived from MIT-licensed tangrams/icons

To refresh:

```bash
curl -fsSL -o /tmp/basemaps-assets.zip \
  https://codeload.github.com/protomaps/basemaps-assets/zip/refs/heads/main
unzip -q /tmp/basemaps-assets.zip -d /tmp
rm -rf public/map/basemaps-assets/fonts public/map/basemaps-assets/sprites
cp -a /tmp/basemaps-assets-main/fonts public/map/basemaps-assets/fonts
mkdir -p public/map/basemaps-assets/sprites
cp -a /tmp/basemaps-assets-main/sprites/v4 public/map/basemaps-assets/sprites/v4
```
