import type { Dayjs } from 'dayjs'
import {
  createJustifiedLayout,
  getPhotoAspectRatio,
  type JustifiedBox,
  type JustifiedLayoutOptions,
} from './justified-layout'

export interface TimelinePhotoItem {
  photo: Photo
  /** Index in the flat display list (for viewer / filters) */
  index: number
  box: JustifiedBox
}

export interface TimelineDayGroup {
  key: string
  /** Parsed day; null for unknown dates */
  date: Dayjs | null
  title: string
  cities: string[]
  photos: TimelinePhotoItem[]
  /** Justified grid height (excludes header) */
  contentHeight: number
  /** Header + content */
  height: number
  /** Cumulative offset from timeline top (set by packer) */
  top: number
}

export interface TimelineMonthSegment {
  key: string
  year: number
  month: number
  label: string
  /** Short label for scrubber side (e.g. "Oct") */
  shortLabel: string
  count: number
  height: number
  top: number
}

export interface TimelineLayout {
  days: TimelineDayGroup[]
  months: TimelineMonthSegment[]
  totalHeight: number
}

const HEADER_HEIGHT_DESKTOP = 48
const HEADER_HEIGHT_MOBILE = 32

export function getTimelineHeaderHeight(isMobile: boolean) {
  return isMobile ? HEADER_HEIGHT_MOBILE : HEADER_HEIGHT_DESKTOP
}

/** Immich-like day title: Today / Yesterday / weekday / Med date */
export function formatTimelineDayTitle(
  date: Dayjs,
  dayjs: (v?: any) => Dayjs,
  t: (key: string) => string,
): string {
  const today = dayjs().startOf('day')
  const d = date.startOf('day')

  if (d.isSame(today, 'day')) {
    return t('ui.timeline.today')
  }
  if (d.isSame(today.subtract(1, 'day'), 'day')) {
    return t('ui.timeline.yesterday')
  }
  if (d.isAfter(today.subtract(7, 'day')) && d.isBefore(today)) {
    return d.format('dddd')
  }
  if (d.isSame(today, 'year')) {
    return d.format('ddd, MMM D')
  }
  return d.format('ll')
}

function collectCities(photos: Photo[]): string[] {
  const cities = new Set<string>()
  for (const photo of photos) {
    const c = (photo.city || '').trim()
    if (c) cities.add(c)
  }
  return [...cities]
}

/**
 * Group photos by calendar day (dateTaken), newest first; unknown dates last.
 * Then run justified layout per day and pack into a vertical timeline.
 */
export function buildTimelineLayout(
  photos: Photo[],
  options: {
    containerWidth: number
    isMobile: boolean
    dayjs: (v?: any) => Dayjs
    t: (key: string, params?: Record<string, unknown>) => string
    layout?: Partial<JustifiedLayoutOptions>
  },
): TimelineLayout {
  const {
    containerWidth,
    isMobile,
    dayjs,
    t,
    layout: layoutOpts = {},
  } = options

  const headerHeight = getTimelineHeaderHeight(isMobile)
  const rowHeight = layoutOpts.targetRowHeight ?? (isMobile ? 100 : 235)
  const spacing = layoutOpts.boxSpacing ?? 2
  // Leave room for the right scrubber on desktop
  const rowWidth = Math.max(
    0,
    containerWidth - (isMobile ? 4 : 8),
  )

  // Group by YYYY-MM-DD
  const order = new Map<string, Array<{ photo: Photo; index: number }>>()
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]!
    const raw = photo.dateTaken
    const key = raw ? dayjs(raw).format('YYYY-MM-DD') : '__unknown__'
    if (!order.has(key)) order.set(key, [])
    order.get(key)!.push({ photo, index: i })
  }

  const sortedKeys = [...order.keys()].sort((a, b) => {
    if (a === '__unknown__') return 1
    if (b === '__unknown__') return -1
    return b < a ? -1 : 1
  })

  const days: TimelineDayGroup[] = []
  let cursor = 0

  for (const key of sortedKeys) {
    const items = order.get(key)!
    const ratios = items.map(({ photo }) => getPhotoAspectRatio(photo))
    const justified = createJustifiedLayout(ratios, {
      containerWidth: rowWidth,
      targetRowHeight: rowHeight,
      boxSpacing: spacing,
      targetRowHeightTolerance: layoutOpts.targetRowHeightTolerance ?? 0.5,
      widowLayoutStyle: layoutOpts.widowLayoutStyle ?? 'left',
    })

    const date = key === '__unknown__' ? null : dayjs(key)
    const title = date
      ? formatTimelineDayTitle(date, dayjs, t)
      : t('ui.timeline.unknownDate')

    const dayPhotos: TimelinePhotoItem[] = items.map((item, i) => ({
      photo: item.photo,
      index: item.index,
      box: justified.boxes[i]!,
    }))

    const contentHeight = justified.containerHeight
    const height = headerHeight + contentHeight

    days.push({
      key,
      date,
      title,
      cities: collectCities(items.map((x) => x.photo)),
      photos: dayPhotos,
      contentHeight,
      height,
      top: cursor,
    })
    cursor += height
  }

  // Build month scrubber segments from day groups
  const monthMap = new Map<string, TimelineMonthSegment>()
  for (const day of days) {
    let year: number
    let month: number
    let label: string
    let shortLabel: string
    if (day.date) {
      year = day.date.year()
      month = day.date.month() + 1
      label = day.date.format('MMM YYYY')
      shortLabel = day.date.format('MMM')
    } else {
      year = 0
      month = 0
      label = t('ui.timeline.unknownDate')
      shortLabel = '—'
    }
    const mKey = `${year}-${month}`
    const existing = monthMap.get(mKey)
    if (existing) {
      existing.height += day.height
      existing.count += day.photos.length
    } else {
      monthMap.set(mKey, {
        key: mKey,
        year,
        month,
        label,
        shortLabel,
        count: day.photos.length,
        height: day.height,
        top: day.top,
      })
    }
  }

  const months = [...monthMap.values()]
  // Fix month tops (first day of each month already set; ensure continuity)
  let mTop = 0
  for (const m of months) {
    m.top = mTop
    mTop += m.height
  }

  return {
    days,
    months,
    totalHeight: cursor,
  }
}
