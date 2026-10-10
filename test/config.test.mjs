/**
 * Config resolution tests: official keys reach the parent resolver; plugin
 * keys are resolved by the plugin; unknown keys still fail load (official
 * validateKeys behavior is NOT weakened).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePluginConfig } from '../lib/config.js'
import { ContextCompactionEngine } from '../lib/index.js'

function stubCtx() {
  return {
    logger: { info() {}, warn() {} },
    on() {},
    get() { return void 0 },
    reflect: { provide() {} },
  }
}

test('plugin config defaults: incremental on, language auto, no extra rules', () => {
  const resolved = resolvePluginConfig()
  assert.deepEqual(resolved, { retentionInstructions: [], incremental: true, summaryLanguage: 'auto' })
})

test('plugin config validation rejects bad values', () => {
  assert.throws(() => resolvePluginConfig({ retentionInstructions: 'x' }), /retentionInstructions must be an array/)
  assert.throws(() => resolvePluginConfig({ retentionInstructions: ['  '] }), /non-empty string/)
  assert.throws(() => resolvePluginConfig({ incremental: 'yes' }), /incremental must be a boolean/)
  assert.throws(() => resolvePluginConfig({ summaryLanguage: 'fr' }), /summaryLanguage must be one of/)
})

test('constructor forwards official keys to the parent and resolves plugin keys', () => {
  const engine = new ContextCompactionEngine(stubCtx(), {
    auto: false,
    thresholdRatio: 0.42,
    retainTokens: 4096,
    headroomTokens: 8192,
    retentionInstructions: ['保留 PR 编号'],
    incremental: false,
    summaryLanguage: 'zh',
  })
  assert.equal(engine.config.thresholdRatio, 0.42)
  assert.equal(engine.config.retainTokens, 4096)
  assert.deepEqual(engine.plugin.retentionInstructions, ['保留 PR 编号'])
  assert.equal(engine.plugin.incremental, false)
  assert.equal(engine.plugin.summaryLanguage, 'zh')
})

test('constructor still rejects unknown keys with the official validator', () => {
  assert.throws(() => new ContextCompactionEngine(stubCtx(), { auto: false, noSuchKey: 1 }), /unknown key "noSuchKey"/)
})
