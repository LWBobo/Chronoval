/**
 * Flickr-style justified row layout (same approach Immich uses via `justified-layout`).
 * Input: aspect ratios (width / height). Output: absolute boxes that fill each row.
 */

export interface JustifiedLayoutOptions {
  containerWidth: number
  targetRowHeight?: number
  boxSpacing?: number
  targetRowHeightTolerance?: number
  /** Incomplete last row: keep target height (Immich default) vs stretch to fill */
  widowLayoutStyle?: 'left' | 'justify'
}

export interface JustifiedBox {
  top: number
  left: number
  width: number
  height: number
}

export interface JustifiedLayoutResult {
  containerHeight: number
  boxes: JustifiedBox[]
}

/**
 * Lay out aspect ratios into justified rows.
 *
 * Greedy fill at target row height; when the next item would overflow, choose
 * the cut (with/without it) whose scaled height is closer to the target
 * (within tolerance). Widows keep target height unless `justify` is set.
 */
export function createJustifiedLayout(
  aspectRatios: number[],
  options: JustifiedLayoutOptions,
): JustifiedLayoutResult {
  const containerWidth = Math.max(0, options.containerWidth)
  const targetRowHeight = options.targetRowHeight ?? 235
  const spacing = options.boxSpacing ?? 2
  const tolerance = options.targetRowHeightTolerance ?? 0.5
  const widowLayoutStyle = options.widowLayoutStyle ?? 'left'

  if (containerWidth <= 0 || aspectRatios.length === 0) {
    return { containerHeight: 0, boxes: [] }
  }

  const ratios = aspectRatios.map((r) => Math.max(0.05, Number(r) || 1))
  const boxes: JustifiedBox[] = Array.from({ length: ratios.length }) as JustifiedBox[]
  let top = 0
  let i = 0

  const sumAspect = (start: number, end: number) => {
    let s = 0
    for (let k = start; k <= end; k++) s += ratios[k]!
    return s
  }

  const place = (start: number, end: number, forceTargetHeight: boolean) => {
    const count = end - start + 1
    const aspectSum = sumAspect(start, end)
    const gaps = spacing * Math.max(0, count - 1)
    let fillRow = !forceTargetHeight
    let rowHeight = forceTargetHeight
      ? targetRowHeight
      : (containerWidth - gaps) / aspectSum

    // Widow / single ultra-wide: never overflow the container
    if (forceTargetHeight && aspectSum * rowHeight + gaps > containerWidth) {
      rowHeight = (containerWidth - gaps) / aspectSum
      fillRow = true
    }

    let left = 0
    for (let k = start; k <= end; k++) {
      let width = ratios[k]! * rowHeight
      if (fillRow && k === end) {
        width = Math.max(1, containerWidth - left)
      }
      boxes[k] = {
        top,
        left,
        width: Math.max(1, width),
        height: Math.max(1, rowHeight),
      }
      left += width + spacing
    }
    top += rowHeight + spacing
  }

  const scaledHeight = (start: number, end: number) => {
    const count = end - start + 1
    const gaps = spacing * Math.max(0, count - 1)
    return (containerWidth - gaps) / sumAspect(start, end)
  }

  const scoreHeight = (h: number) => {
    const minH = targetRowHeight * (1 - tolerance)
    const maxH = targetRowHeight * (1 + tolerance)
    const dist = Math.abs(h - targetRowHeight)
    return h < minH || h > maxH ? dist + targetRowHeight : dist
  }

  while (i < ratios.length) {
    let rowEnd = i

    // Grow while the row still fits at the target height
    while (rowEnd + 1 < ratios.length) {
      const nextCount = rowEnd + 1 - i + 1
      const nextGaps = spacing * Math.max(0, nextCount - 1)
      const nextWidth = sumAspect(i, rowEnd + 1) * targetRowHeight + nextGaps
      if (nextWidth > containerWidth) break
      rowEnd++
    }

    const isLast = rowEnd === ratios.length - 1

    if (isLast) {
      place(i, rowEnd, widowLayoutStyle === 'left')
      break
    }

    // Decide whether to pull in the overflowing next item
    const without = rowEnd
    const withExtra = rowEnd + 1
    const hWithout = scaledHeight(i, without)
    const hWith = scaledHeight(i, withExtra)

    // Always advance at least one item
    if (without < i) {
      place(i, i, false)
      i++
      continue
    }

    if (scoreHeight(hWith) < scoreHeight(hWithout)) {
      place(i, withExtra, false)
      i = withExtra + 1
    } else {
      place(i, without, false)
      i = without + 1
    }
  }

  return {
    containerHeight: Math.max(0, top - spacing),
    boxes,
  }
}

/** Photo aspect ratio as width/height (CSS aspect-ratio). */
export function getPhotoAspectRatio(photo: {
  aspectRatio?: number | null
  width?: number | null
  height?: number | null
}): number {
  if (photo.aspectRatio && photo.aspectRatio > 0) {
    return photo.aspectRatio
  }
  if (photo.width && photo.height && photo.height > 0) {
    return photo.width / photo.height
  }
  return 1
}
