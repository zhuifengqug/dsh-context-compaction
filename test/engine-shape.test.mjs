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
  // The plugin may add private helpers of its own (e.g. registration wiring);
  // what must never appear on the prototype is a redefinition of an OFFICIAL
  // operation. Assert on that intent directly instead of a closed method list.
  const officialOperations = ['compactIfNeeded', 'compactRegion', 'compactNow', 'regionDependencies']
  for (const overridden of officialOperations) {
    assert.equal(ownMethods.includes(overridden), false, `${overridden} must not be overridden`)
  }
  assert.ok(ownMethods.includes('summarize'), 'summarize must be the plugin hook')
  for (const inherited of ['compactIfNeeded', 'compactRegion', 'compactNow']) {
    assert.equal(Object.getOwnPropertyDescriptor(ContextCompactionEngine.prototype, inherited), undefined, `${inherited} must not be overridden`)
    assert.equal(typeof ContextCompactionEngine.prototype[inherited], 'function', `${inherited} must remain the official implementation`)
  }
})

test('inject list matches the official engine (llm, tokenMeter, sessions)', () => {
  assert.deepEqual(ContextCompactionEngine.inject, BasicCompactionEngine.inject)
  assert.deepEqual(ContextCompactionEngine.inject, ['llm', 'tokenMeter', 'sessions'])
})
