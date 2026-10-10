/**
 * Trigger-threshold integration tests — the acceptance evidence that
 * "config threshold takes effect: after lowering the threshold, compaction
 * fires at a lower occupancy (reproducible)".
 *
 * The test drives the REAL inherited `compactIfNeeded('pressure')` machinery
 * (official resolveCompactSpec threshold formula, surface range selection,
 * tool-pairing checks, durable compaction transaction) against a stub
 * session/meter/llm. One fixed occupancy (105000 tokens of a 256000-token
 * window ≈ 41%):
 *
 *   - official default thresholdRatio 0.8 → threshold 157696 → NO compaction (null)
 *   - lowered thresholdRatio 0.35 → threshold 89600  → compaction RUNS and commits
 *
 * The same tests exercise the plugin summarize() hook through the official
 * transaction, verifying the return contract (no undefined fields — checked
 * with the host's own snapshotJsonValue) and the incremental/language
 * instruction selection.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { ContextCompactionEngine } from '../lib/index.js'

const CONTEXT_WINDOW = 256000
const RESERVED_COMPLETION = 32768
const NODE_TOKENS = 26250
// Session logs are strictly contiguous (seq 0..n, t1 §3.3): the stub mirrors that.
const SURFACE_SEQS = [1, 2, 3, 4]
const TOTAL_TOKENS = NODE_TOKENS * SURFACE_SEQS.length
const CHECKPOINT_NODE_TOKENS = 60
// Per-session baseline pricing: surface nodes cost NODE_TOKENS each; after a
// compaction the synthesized checkpoint node costs CHECKPOINT_NODE_TOKENS.
const baselineTokens = new Map(SURFACE_SEQS.map((seq) => [seq, NODE_TOKENS]))

function stubSession() {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '用户消息A：请修复 compressSession，路径 D:\\dsh-workspaces\\dev\\src\\index.ts' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手回复A：已修复，报错 TS2322 已消除。' }] } } },
    { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '用户消息B：运行 pnpm run typecheck 并提交。' }] } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手回复B：typecheck 通过，已提交。' }] } } },
  ]
    // Host `eventAt(seq)` reads `this.log[seq]`; the log is strictly contiguous,
  // so the stub uses array-index semantics rather than a seq-keyed map.
  const log = [...events]
  const session = {
    id: 'stub-session',
    get seq() { return log.length },
    log,
    eventAt(seq) { return log[seq] },
    requestHeader() { return { config: { provider: 'stub', model: 'stub-model', maxTokens: RESERVED_COMPLETION } } },
    // Mirror the official surface bookkeeping: a `replace` appends a checkpoint
    // node and the shadowed nodes leave the visible surface.
    surface: { nodes: [...SURFACE_SEQS], replaceGeneration: 1, contentGeneration: 1 },
    deriveEventMessage(event) {
      const content = event.type === 'assistant/message' ? event.data.message.content : event.data.content
      return { role: event.type === 'assistant/message' ? 'assistant' : 'user', content }
    },
    toolHistory() { return [] },
    append(type, data, options) {
      const event = { seq: log.length, type, data, ...options }
      log.push(event)
      if (type === 'user/message' && options?.surfaceOp?.op === 'replace') {
        session.surface.nodes = [event.seq]
        session.surface.replaceGeneration += 1
        session.surface.contentGeneration += 1
        baselineTokens.set(event.seq, CHECKPOINT_NODE_TOKENS)
      }
      return event
    },
  }
  return session
}

function makeCtx(captured, session) {
  return {
    logger: { info() {}, warn() {} },
    on() {},
    get() { return void 0 },
    reflect: { provide() {} },
    tokenMeter: {
      // Price the CURRENT surface like the real meter: baseline nodes cost
      // NODE_TOKENS each; the synthesized checkpoint node is tiny.
      measure() {
        const nodes = session.surface.nodes
        return {
          totalTokens: nodes.reduce((total, seq) => total + (baselineTokens.get(seq) ?? CHECKPOINT_NODE_TOKENS), 0),
          nodes: nodes.map((seq) => ({ seq, tokens: baselineTokens.get(seq) ?? CHECKPOINT_NODE_TOKENS, heuristicTokens: baselineTokens.get(seq) ?? CHECKPOINT_NODE_TOKENS })),
        }
      },
      estimateMessage(message) {
        const text = (message?.content ?? []).map((block) => block?.text ?? '').join('')
        return Math.ceil(text.length / 4) + 24
      },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: CONTEXT_WINDOW }, defaultMaxTokens: RESERVED_COMPLETION }
      },
      async *stream(options) {
        captured.push(options)
        const text = '<compacted-summary>\n## Primary Request and Intent\n- 修复 compressSession\n## Pending Jobs\n- 提交修复\n</compacted-summary>'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

function stubAgent(session) {
  return { session, options: {} }
}

test('occupancy below the official default threshold (0.8) does not compact', async () => {
  const captured = []
  const session = stubSession()
  const engine = new ContextCompactionEngine(makeCtx(captured, session), { auto: false, thresholdRatio: 0.8 })
  const result = await engine.compactIfNeeded(stubAgent(session), 'pressure', undefined)
  assert.equal(result, null, `expected null at ${TOTAL_TOKENS}/${CONTEXT_WINDOW} tokens with default threshold`)
  assert.equal(captured.length, 0, 'summarizer must not be called below threshold')
})

test('lowered threshold (0.35) compacts at the SAME occupancy and commits the official transaction', async () => {
  const captured = []
  const session = stubSession()
  const ctx = makeCtx(captured, session)
  const engine = new ContextCompactionEngine(ctx, { auto: false, thresholdRatio: 0.35, retainTokens: 10000 })
  const result = await engine.compactIfNeeded(stubAgent(session), 'pressure', undefined)
  assert.notEqual(result, null, 'expected a committed compaction below the lowered threshold')
  assert.equal(result.shadowedRange.start, SURFACE_SEQS[0])
  assert.equal(result.shadowedRange.end, SURFACE_SEQS[2])
  assert.deepEqual(result.shadowedSeqs, [1, 2, 3])
  assert.equal(typeof result.compactionId, 'string')
  assert.equal(result.shadowedTokenCount, NODE_TOKENS * 3)
  // Official durable transaction: unmatched start, one summary, clean end.
  const types = session.log.filter((event) => String(event.type).startsWith('compaction/')).map((event) => event.type)
  assert.deepEqual(types, ['compaction/start', 'compaction/summary', 'compaction/end'])
  const endEvent = session.log.find((event) => event.type === 'compaction/end')
  assert.equal(endEvent.data.error, undefined, 'compaction must end cleanly')
  // The plugin instruction ran through the official hook with zh language.
  const summaryOptions = captured[0]
  assert.equal(summaryOptions.provider, 'stub')
  assert.equal(summaryOptions.purpose, 'compaction')
  const instruction = summaryOptions.messages.at(-1).content[0].text
  assert.match(instruction, /你是本 AI 编码助手的压缩引擎/)
  assert.match(instruction, /摘要用简体中文撰写/)
  assert.match(instruction, /文件绝对路径/)
})

test('threshold formula (official mirror): lowering ratio lowers thresholdTokens', () => {
  // Mirror of dsh-compaction-basic resolveCompactSpec L124-147 (verified against lib/index.js).
  const threshold = (ratio) => Math.floor(Math.min(CONTEXT_WINDOW * ratio, CONTEXT_WINDOW - RESERVED_COMPLETION - 65536))
  assert.equal(threshold(0.8), 157696)
  assert.equal(threshold(0.35), 89600)
  assert.ok(threshold(0.35) < threshold(0.8))
  assert.ok(TOTAL_TOKENS >= threshold(0.35), 'fixed occupancy must clear the lowered threshold')
  assert.ok(TOTAL_TOKENS < threshold(0.8), 'fixed occupancy must stay below the default threshold')
})

test('summarize return contract: no undefined fields (snapshotJsonValue accepted), usage omitted when absent', async () => {
  const captured = []
  const engine = new ContextCompactionEngine(makeCtx(captured), { auto: false, thresholdRatio: 0.35, retainTokens: 10000 })
  const session = stubSession()
  const input = { messages: SURFACE_SEQS.slice(0, 3).map((seq) => session.deriveEventMessage(session.eventAt(seq))) }
  const result = await engine.summarize(input, stubAgent(session), undefined)
  assert.equal(result.llmStreamCall, true)
  assert.equal(result.provider, 'stub')
  assert.equal(result.model, 'stub-model')
  assert.equal(result.maxTokens, 65536)
  assert.equal('usage' in result, false, 'usage must be omitted entirely when the stream carried none')
  const snapshotted = snapshotJsonValue(result)
  assert.notEqual(snapshotted, undefined, 'snapshotJsonValue must accept the whole result (no undefined fields)')
  assert.deepEqual(Object.keys(snapshotted), ['summary', 'rawOutput', 'llmStreamCall', 'provider', 'model', 'maxTokens'])
})

test('incremental mode merges prior checkpoint instead of replaying it', async () => {
  const captured = []
  const ctx = makeCtx(captured)
  ctx.llm.stream = async function * (options) {
    captured.push(options)
    const text = '<compacted-summary>\n## Primary Request and Intent\n- 合并后的意图\n</compacted-summary>'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const engine = new ContextCompactionEngine(ctx, { auto: false, thresholdRatio: 0.35, retainTokens: 10000 })
  const session = stubSession()
  const priorCheckpoint = { role: 'user', content: [{ type: 'text', text: '<compacted-summary>\n## Pending Jobs\n- 旧检查点中的未决事项\n</compacted-summary>' }] }
  const input = {
    messages: [priorCheckpoint, ...SURFACE_SEQS.slice(0, 3).map((seq) => session.deriveEventMessage(session.eventAt(seq)))],
  }
  await engine.summarize(input, stubAgent(session), undefined)
  const instruction = captured[0].messages.at(-1).content[0].text
  assert.match(instruction, /增量模式：本区间内包含一份旧检查点/)
  assert.match(instruction, /保留旧检查点中仍然成立的事实/)
  // Prior checkpoint stays as context input; instruction is the only appended message.
  assert.equal(captured[0].messages.length, input.messages.length + 1)
})
