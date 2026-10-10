/**
 * Inheritance-shape tests: the plugin engine must extend the official
 * BasicCompactionEngine and override ONLY the summarize hook — every other
 * official mechanism (pressure trigger, overflow recovery, compactRegion,
 * compactNow) stays the parent implementation, untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { ContextCompactionEngine } from '../lib/index.js'

test('extends the official BasicCompactionEngine and CompactionEngine service base', () => {
  assert.equal(Object.getPrototypeOf(ContextCompactionEngine.prototype), BasicCompactionEngine.prototype)
  assert.ok(ContextCompactionEngine.prototype instanceof CompactionEngine)
})

test('overrides only summarize; official operations are inherited, not redefined', () => {
  const ownMethods = Object.getOwnPropertyNames(ContextCompactionEngine.prototype)
    .filter((name) => name !== 'constructor')
  assert.deepEqual(ownMethods, ['summarize'])
  for (const inherited of ['compactIfNeeded', 'compactRegion', 'compactNow']) {
    assert.equal(Object.getOwnPropertyDescriptor(ContextCompactionEngine.prototype, inherited), undefined, `${inherited} must not be overridden`)
    assert.equal(typeof ContextCompactionEngine.prototype[inherited], 'function', `${inherited} must remain the official implementation`)
  }
})

test('inject list matches the official engine (llm, tokenMeter, sessions)', () => {
  assert.deepEqual(ContextCompactionEngine.inject, BasicCompactionEngine.inject)
  assert.deepEqual(ContextCompactionEngine.inject, ['llm', 'tokenMeter', 'sessions'])
})
