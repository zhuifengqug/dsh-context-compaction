import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  ContextCompactionEngine,
  registerVisibilityTools,
  collectCompactionRecords,
  parseRange,
  readEventRange,
  exportOriginal,
  parseSearchQuery,
  searchReadableEvents,
} from '../lib/index.js'

function harnessContext() {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return undefined
      if (name === 'tokenMeter') return undefined
      if (name === 'compaction') return undefined
      throw new Error(`unexpected service ${name}`)
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

function exec(agent = { session: { id: 'session-test' }, options: { cwd: tmpdir() } }) {
  return { agent }
}

const events = [
  { seq: 1, type: 'compaction/start', data: { compactionId: 'c1', turn: null } },
  { seq: 2, type: 'compaction/summary', data: { compactionId: 'c1', shadowedRange: { start: 1, end: 3 }, shadowedSeqs: [1, 2, 3], shadowedTokenCount: 42, provider: 'p', model: 'm', summary: [{ type: 'text', text: 'summary' }] } },
  { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'needle in shadowed message' }] } },
  { seq: 4, type: 'compaction/end', data: { compactionId: 'c1' } },
]

test('registers the three tools with the native defineTool contract', () => {
  const { ctx, registered } = harnessContext()
  const dispose = registerVisibilityTools(ctx)
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(registered.map((tool) => tool.name), ['context_status', 'context_expand', 'context_search'])
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.parameters && typeof tool.parameters === 'object')
    assert.ok(tool.output.schema && typeof tool.output.schema === 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('parses and reads event ranges with explicit missing seqs', () => {
  assert.deepEqual(parseRange(1, 4), { start: 1, end: 4 })
  assert.throws(() => parseRange(4, 1), /greater than/)
  const { found, missing } = readEventRange(events, { start: 1, end: 4 })
  assert.equal(found.length, 4)
  assert.deepEqual(missing, [])
})

test('collects completed compaction records from durable events', () => {
  const records = collectCompactionRecords(events)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'completed')
  assert.deepEqual(records[0].shadowedRange, { start: 1, end: 3 })
})

test('expands original events and exports a workspace file without surface restoration', async () => {
  const { ctx, registered } = harnessContext()
  registerVisibilityTools(ctx, {
    sessionQuery: { observeSession: () => ({ session: 'observed', events }) },
    tokenMeter: { measure: () => ({ totalTokens: 90, nodes: [{}, {}] }) },
    compaction: { config: { thresholdRatio: 0.5, headroomTokens: 1000 } },
  })
  const expand = registered.find((tool) => tool.name === 'context_expand')
  const root = await fs.mkdtemp(path.join(tmpdir(), 'context-expand-'))
  const exportPath = path.join(root, 'original.md')
  const value = await expand.execute({ start: 1, end: 4, exportPath }, exec())
  assert.equal(value.surfaceRestore, false)
  assert.match(value.notice, /NOT restored to the model-visible surface/)
  assert.match(value.notice, /Read exportedFile/)
  assert.equal(value.exportedFile, exportPath)
  const text = await fs.readFile(exportPath, 'utf8')
  assert.match(text, /## seq 3 · user\/message/)
  assert.match(text, /needle in shadowed message/)
  await fs.rm(root, { recursive: true, force: true })
})

test('expand returns explicit errors for invalid ranges or missing sessions', async () => {
  const { ctx, registered } = harnessContext()
  registerVisibilityTools(ctx, { sessionQuery: { observeSession: () => ({ events }) } })
  const expand = registered.find((tool) => tool.name === 'context_expand')
  await assert.rejects(() => expand.execute({ start: 4, end: 1 }, exec()), /greater than/)
  const noQuery = harnessContext()
  registerVisibilityTools(noQuery.ctx)
  const noQueryExpand = noQuery.registered.find((tool) => tool.name === 'context_expand')
  await assert.rejects(() => noQueryExpand.execute({ start: 1, end: 1 }, exec()), /sessionQuery is unavailable/)
})

test('search finds shadowed text with the owning seq', async () => {
  const { ctx, registered } = harnessContext()
  registerVisibilityTools(ctx, {
    sessionQuery: { observeSession: () => ({ events }) },
    compaction: { config: { thresholdRatio: 0.5, headroomTokens: 1000 } },
  })
  const search = registered.find((tool) => tool.name === 'context_search')
  const value = await search.execute({ query: 'needle', surface: 'shadowed', limit: 10 }, exec())
  assert.equal(value.hitCount, 1)
  assert.equal(value.hits[0].seq, 3)
  assert.equal(value.hits[0].surface, 'shadowed')
  assert.match(value.hits[0].snippet, /needle/)
})

test('status reports official meter pressure and durable compaction intervals', async () => {
  const { ctx, registered } = harnessContext()
  registerVisibilityTools(ctx, {
    sessionQuery: { observeSession: () => ({ events }) },
    tokenMeter: { measure: () => ({ totalTokens: 200, nodes: [{}, {}] }) },
    compaction: { config: { thresholdRatio: 0.5, headroomTokens: 1000 } },
  })
  const status = registered.find((tool) => tool.name === 'context_status')
  const value = await status.execute({}, exec())
  assert.equal(value.occupancy.totalTokens, 200)
  // F2 regression: the field must NOT be named thresholdTokens and must not
  // claim to be the trigger point. The real trigger is computed by the
  // official engine from the routed model WINDOW, not from occupancy.
  assert.equal(value.occupancy.thresholdTokens, undefined)
  assert.equal(value.occupancy.occupancyRatioReference, 100)
  assert.match(value.occupancy.thresholdNote, /NOT the trigger point/)
  assert.equal(value.compactions.length, 1)
  assert.equal(value.compactions[0].compactionId, 'c1')
  assert.equal(value.compactions[0].status, 'completed')
})

test('search helpers use literal terms and return shadowed seq hits', () => {
  assert.deepEqual(parseSearchQuery('  Needle   path '), ['needle', 'path'])
  const hits = searchReadableEvents([{ seq: 7, type: 'user/message', data: { content: [{ type: 'text', text: 'the needle is here' }] } }], ['needle'], 'shadowed', 10)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].seq, 7)
})

// ---------------------------------------------------------------------------
// t4 findings F1 / F2 — regression tests (added by t6 repair)
// ---------------------------------------------------------------------------

// F1 regression (t4 minimal repro C2d): a text that appears ONLY on a
// non-shadowed seq must not be returned when surface='shadowed' (the default).
test('F1: surface=shadowed filters out non-shadowed hits', async () => {
  const { ctx, registered } = harnessContext()
  registerVisibilityTools(ctx, {
    sessionQuery: { observeSession: () => ({ events: [...events, { seq: 7, type: 'user/message', data: { content: [{ type: 'text', text: 'needle-visible' }] } }] }) },
    tokenMeter: { measure: () => ({ totalTokens: 10, nodes: [] }) },
    compaction: { config: { thresholdRatio: 0.5, headroomTokens: 100 } },
  })
  const search = registered.find((tool) => tool.name === 'context_search')

  const shadowed = await search.execute({ query: 'needle-visible', surface: 'shadowed' }, exec())
  assert.equal(shadowed.hitCount, 0, 'a log-only hit must not appear on the shadowed surface')

  const all = await search.execute({ query: 'needle-visible', surface: 'all' }, exec())
  assert.equal(all.hitCount, 1, 'surface=all must still surface log-only hits')
  assert.equal(all.hits[0].seq, 7)
  assert.equal(all.hits[0].surface, 'log-only')
})

// F1 regression: the filter must apply BEFORE the limit is consumed, so a
// small limit can never be filled by excluded events.
test('F1: shadowed filter is applied before the result limit', async () => {
  const noise = Array.from({ length: 5 }, (_, index) => ({
    seq: 100 + index,
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'needle-noise' }] },
  }))
  const hits = searchReadableEvents(
    [...noise, { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'needle-shadowed' }] } }],
    ['needle'],
    (event) => (event.seq === 3 ? 'shadowed' : 'log-only'),
    2,
    'shadowed',
  )
  assert.equal(hits.length, 1)
  assert.equal(hits[0].seq, 3)
})

// F2 regression (t4 minimal repro C3c): the reported value must not be
// presented as a trigger threshold, and its name must not imply one.
test('F2: status exposes a ratio reference, never a drifting "thresholdTokens"', async () => {
  const build = async (totalTokens) => {
    const { ctx, registered } = harnessContext()
    registerVisibilityTools(ctx, {
      sessionQuery: { observeSession: () => ({ events }) },
      tokenMeter: { measure: () => ({ totalTokens, nodes: [] }) },
      compaction: { config: { thresholdRatio: 0.5, headroomTokens: 1000 } },
    })
    const status = registered.find((tool) => tool.name === 'context_status')
    return status.execute({}, exec())
  }

  const small = await build(20000)
  const large = await build(40000)

  assert.equal(small.occupancy.thresholdTokens, undefined)
  assert.equal(small.occupancy.occupancyRatioReference, 10000)
  assert.equal(large.occupancy.occupancyRatioReference, 20000)
  // The value does drift (it is occupancy-scaled by construction) — which is
  // exactly why it must not be named or described as the trigger threshold.
  assert.notEqual(small.occupancy.occupancyRatioReference, large.occupancy.occupancyRatioReference)
  assert.match(small.occupancy.thresholdNote, /contextWindow/)
  assert.match(small.occupancy.thresholdNote, /NOT the trigger point/)
})

test('exportOriginal rejects paths outside the workspace root', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'context-export-'))
  const outside = path.join(tmpdir(), `context-outside-${Date.now()}.md`)
  await assert.rejects(() => exportOriginal({ options: { cwd: root } }, { start: 1, end: 1 }, events, outside), /outside workspace root/)
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { force: true })
})

test('index re-exports the engine and tool setup helper', () => {
  assert.equal(ContextCompactionEngine.name, 'ContextCompactionEngine')
  assert.equal(typeof registerVisibilityTools, 'function')
})
