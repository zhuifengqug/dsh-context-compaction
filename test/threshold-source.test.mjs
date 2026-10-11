/**
 * Engine threshold-source tests: the settings card's saved file overrides the
 * threshold keys, malformed or absent files degrade to the preset's config, and
 * a bad file never breaks construction.
 *
 * The engine's constructor calls super() with the merged config, so these tests
 * inspect the resolved policy through a minimal subclass stub rather than a
 * live Cordis realm.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePolicy, toEngineConfig, OFFICIAL_DEFAULTS } from '../lib/threshold-settings.js'
import { readStoredSettingsSync, settingsFilePath } from '../lib/settings-endpoint.js'
import { mergeThresholds as mergeThresholdsForTest } from '../lib/engine.js'

function withTempHome(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return run(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

test('settingsFilePath follows $DSH_HOME', () => {
  withTempHome((dir) => {
    assert.equal(settingsFilePath(), join(dir, 'context-compaction.json'))
  })
})

test('no saved file means no override', () => {
  withTempHome(() => {
    assert.equal(readStoredSettingsSync(), undefined)
    const merged = { ...OFFICIAL_DEFAULTS }
    assert.equal(merged.thresholdRatio, 0.8)
  })
})

test('a saved file overrides the threshold keys', () => {
  withTempHome((dir) => {
    writeFileSync(join(dir, 'context-compaction.json'), JSON.stringify({
      version: 1,
      settings: { thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 },
    }))
    const saved = readStoredSettingsSync()
    assert.ok(saved)
    const { policy, source } = resolvePolicy(saved)
    assert.equal(source, 'stored')
    const engineConfig = toEngineConfig(policy)
    assert.equal(engineConfig.thresholdRatio, 0.5)
    assert.equal(engineConfig.headroomTokens, 32768)
    assert.equal('retainTokens' in engineConfig, false)
  })
})

test('a malformed file degrades to no override instead of throwing', () => {
  withTempHome((dir) => {
    writeFileSync(join(dir, 'context-compaction.json'), '{ this is not json')
    assert.equal(readStoredSettingsSync(), undefined)
  })
})

test('an out-of-range file value is rejected, not silently applied', () => {
  withTempHome((dir) => {
    writeFileSync(join(dir, 'context-compaction.json'), JSON.stringify({
      version: 1,
      settings: { thresholdRatio: 42, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 },
    }))
    assert.equal(readStoredSettingsSync(), undefined)
  })
})

test('saved settings never leave BOTH retention keys in the merged config', () => {
  // Regression: the official validator rejects a config carrying retainRatio and
  // retainTokens together, and construction used to fail whenever the caller
  // pinned retainTokens while a saved file supplied retainRatio.
  withTempHome((dir) => {
    writeFileSync(join(dir, 'context-compaction.json'), JSON.stringify({
      version: 1,
      settings: { thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 },
    }))
    const merged = mergeThresholdsForTest({ retainTokens: 8192 }, readStoredSettingsSync())
    // The saved file is authoritative: it says "use the ratio", so the caller's
    // pinned token count is dropped rather than kept alongside retainRatio.
    assert.equal('retainTokens' in merged, false, 'the file leaves retainTokens at 0, so it must be dropped')
    assert.equal(merged.retainRatio, 0.16, 'the file ratio takes effect')
    assert.equal(merged.thresholdRatio, 0.5)
  })
})

test('saved settings supply retainTokens only when pinned above zero', () => {
  withTempHome((dir) => {
    writeFileSync(join(dir, 'context-compaction.json'), JSON.stringify({
      version: 1,
      settings: { thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.2, retainTokens: 4096 },
    }))
    const merged = mergeThresholdsForTest({ retainRatio: 0.16 }, readStoredSettingsSync())
    assert.equal(merged.retainTokens, 4096, 'the pinned token count from the file takes effect')
    assert.equal('retainRatio' in merged, false, 'retainRatio must be dropped to stay mutually exclusive')
  })
})

test('a caller-pinned retainTokens survives when no file is saved', () => {
  withTempHome(() => {
    // Without a saved file the preset's own config passes through untouched.
    const merged = mergeThresholdsForTest({ retainTokens: 8192, thresholdRatio: 0.7 }, readStoredSettingsSync())
    assert.equal(merged.retainTokens, 8192)
    assert.equal(merged.thresholdRatio, 0.7)
    assert.equal('retainRatio' in merged, false)
  })
})

test('mergeThresholds accepts a persisted envelope as well as bare settings', () => {
  // Passing the {version, settings} document must not yield undefined keys.
  const fromEnvelope = mergeThresholdsForTest({ thresholdRatio: 0.9 }, {
    version: 1,
    settings: { thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 },
  })
  assert.equal(fromEnvelope.thresholdRatio, 0.5)
  assert.equal(fromEnvelope.headroomTokens, 32768)
  const fromBare = mergeThresholdsForTest({ thresholdRatio: 0.9 }, {
    thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0,
  })
  assert.equal(fromBare.thresholdRatio, 0.5)
})
