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
  assert.equal(value.occupancy.thresholdTokens, 100)
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
