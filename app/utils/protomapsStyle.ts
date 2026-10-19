import {
  language_script_pairs,
  layers,
  namedFlavor,
} from '@protomaps/basemaps'
import type { StyleSpecification } from 'maplibre-gl'

const SUPPORTED_LANGS = new Set(language_script_pairs.map((pair) => pair.lang))

/** Map a Chronoval locale onto a Protomaps label language. */
export function protomapsLang(locale: string): string {
  if (
    locale === 'zh-Hant-TW' ||
    locale === 'zh-Hant-HK' ||
    locale.startsWith('zh-Hant')
  ) {
    return 'zh-Hant'
  }
  if (locale.startsWith('zh')) return 'zh-Hans'
  if (SUPPORTED_LANGS.has(locale)) return locale
  const short = locale.split('-')[0] || 'en'
  if (SUPPORTED_LANGS.has(short)) return short
  return 'en'
}

export function protomapsStyle(options: {
  dark: boolean
  lang: string
  tileUrl: string
}): StyleSpecification {
  const flavor = options.dark ? 'dark' : 'light'
  return {
    version: 8,
    glyphs:
      'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavor}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: options.tileUrl,
        attribution:
          '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: layers('protomaps', namedFlavor(flavor), {
      lang: options.lang,
    }) as StyleSpecification['layers'],
  }
}
