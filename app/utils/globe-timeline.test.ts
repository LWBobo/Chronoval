import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTimelineModel,
  groupTimelinePlaces,
  progressForTimelineTimestamp,
  timelinePhotoCountAt,
  timestampForTimelineProgress,
} from './globe-timeline.ts'

const day = 24 * 60 * 60 * 1000
const photo = (
  id: string,
  latitude: number,
  longitude: number,
  timestamp: number,
) => ({
  photo: { id, latitude, longitude },
  timestamp,
})

test('groups nearby photos only while the time gap stays within seven days', () => {
  const places = groupTimelinePlaces([
    photo('a', 34.75, 113.62, 0),
    photo('b', 34.76, 113.63, day),
    photo('c', 34.76, 113.63, 9 * day),
  ])
  assert.equal(places.length, 2)
  assert.deepEqual(
    places.map((place) => place.photos.length),
    [2, 1],
  )
})

test('compresses long calendar gaps into bounded playback time', () => {
  const model = buildTimelineModel([
    photo('a', 34.75, 113.62, 0),
    photo('b', 31.23, 121.47, 365 * day),
    photo('c', 39.9, 116.4, 730 * day),
  ])!
  assert.ok(model.durationMs < 12_000)
  const middleTimestamp = timestampForTimelineProgress(model, 50)
  assert.ok(middleTimestamp > 0 && middleTimestamp < 730 * day)
})

test('progress and timestamp mapping remain monotonic and approximately reversible', () => {
  const entries = [
    photo('a', 34.75, 113.62, 0),
    photo('b', 34.76, 113.63, day),
    photo('c', 31.23, 121.47, 200 * day),
  ]
  const model = buildTimelineModel(entries)!
  const progress = progressForTimelineTimestamp(model, 100 * day)
  const timestamp = timestampForTimelineProgress(model, progress)
  assert.ok(progress > 0 && progress < 100)
  assert.ok(Math.abs(timestamp - 100 * day) < 1000)
  assert.equal(timelinePhotoCountAt(entries, day), 2)
})
