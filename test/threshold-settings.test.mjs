/**
 * Threshold settings model tests: validation bounds, document round-trip,
 * policy resolution, and the engine-config projection that the patch
 * generator consumes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  THRESHOLD_FIELDS,
  OFFICIAL_DEFAULTS,
  RECOMMENDED_PRESETS,
  validateField,
  validateSettings,
  toDocument,
  fromDocument,
  resolvePolicy,
  toEngineConfig,
  ThresholdSettingsError,
} from '../lib/threshold-settings.js'

test('field specs carry the official defaults', () => {
  const byKey = Object.fromEntries(THRESHOLD_FIELDS.map((f) => [f.key, f]))
  assert.equal(byKey.thresholdRatio.officialDefault, 0.8)
  assert.equal(byKey.headroomTokens.officialDefault, 65536)
  assert.equal(byKey.retainRatio.officialDefault, 0.16)
  assert.equal(byKey.thresholdRatio.fractional, true)
  assert.equal(byKey.headroomTokens.fractional, false)
})

test('validateField rejects non-numbers, out-of-range, and fractional integers', () => {
  const ratio = THRESHOLD_FIELDS.find((f) => f.key === 'thresholdRatio')
  const tokens = THRESHOLD_FIELDS.find((f) => f.key === 'headroomTokens')
  assert.equal(validateField(ratio, 0.5), 0.5)
  assert.equal(validateField(tokens, 32768), 32768)
  assert.throws(() => validateField(ratio, '0.5'), ThresholdSettingsError)
  assert.throws(() => validateField(ratio, Number.NaN), ThresholdSettingsError)
  assert.throws(() => validateField(ratio, 1.5), ThresholdSettingsError)
  assert.throws(() => validateField(tokens, 1.5), ThresholdSettingsError)
  assert.throws(() => validateField(tokens, -1), ThresholdSettingsError)
})

test('validateSettings rejects unknown and missing keys', () => {
  const good = { thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 }
  assert.deepEqual(validateSettings(good), good)
  assert.throws(() => validateSettings({ ...good, bogus: 1 }), /unknown settings field/)
  const { retainTokens, ...missing } = good
  assert.throws(() => validateSettings(missing), /missing settings field/)
  assert.throws(() => validateSettings(null), /plain object/)
  assert.throws(() => validateSettings([]), /plain object/)
})

test('document round-trip preserves settings and tolerates bad input', () => {
  const settings = { thresholdRatio: 0.65, headroomTokens: 49152, retainRatio: 0.16, retainTokens: 0 }
  const doc = toDocument(settings)
  assert.equal(doc.version, 1)
  assert.deepEqual(fromDocument(doc), settings)
  // A bare settings object (no envelope) is still accepted.
  assert.deepEqual(fromDocument(settings), settings)
  assert.equal(fromDocument(null), undefined)
  assert.equal(fromDocument({ settings: { thresholdRatio: 99 } }), undefined)
})

test('resolvePolicy reports its source and defaults to the official values', () => {
  const none = resolvePolicy()
  assert.equal(none.source, 'official-defaults')
  assert.equal(none.policy.thresholdRatio, OFFICIAL_DEFAULTS.thresholdRatio)
  const stored = resolvePolicy({ thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 })
  assert.equal(stored.source, 'stored')
  assert.equal(stored.policy.thresholdRatio, 0.5)
})

test('toEngineConfig omits retainTokens when zero so retainRatio keeps effect', () => {
  const zero = toEngineConfig({ thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 })
  assert.deepEqual(zero, { thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16 })
  assert.equal('retainTokens' in zero, false)
  const pinned = toEngineConfig({ thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 8192 })
  assert.equal(pinned.retainTokens, 8192)
})

test('every recommended preset validates and is strictly earlier than the official default', () => {
  for (const [name, preset] of Object.entries(RECOMMENDED_PRESETS)) {
    assert.deepEqual(validateSettings(preset), preset, `${name} must validate`)
  }
  assert.ok(RECOMMENDED_PRESETS.aggressive.thresholdRatio < OFFICIAL_DEFAULTS.thresholdRatio)
  assert.ok(RECOMMENDED_PRESETS.balanced.thresholdRatio < OFFICIAL_DEFAULTS.thresholdRatio)
  assert.equal(RECOMMENDED_PRESETS.conservative.thresholdRatio, OFFICIAL_DEFAULTS.thresholdRatio)
})
