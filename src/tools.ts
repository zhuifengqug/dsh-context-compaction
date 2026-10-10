/**
 * Visibility and rollback tools for compaction:
 *
 * - `context_status`: current token occupancy, configured thresholds,
 *   remaining headroom, and compacted intervals read from durable
 *   `compaction/summary` events.
 * - `context_expand`: read the original (shadowed) events for a seq range
 *   through `ctx.sessionQuery` and export them to a workspace file. The host
 *   has no un-replace API; this tool does not and cannot put the original
 *   back on the model-visible surface. The result states that limitation
 *   explicitly and tells the model to read the exported file.
 * - `context_search`: search only `shadowed` events for a query and return
 *   bounded hits with their seq numbers.
 *
 * Error paths are explicit: missing sessionQuery, invalid ranges, missing
 * seqs, and sessions with no compacted records return `isError: true` with
 * actionable text; nothing is silently ignored.
 *
 * @module @gjs27/dsh-context-compaction/tools
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Session sequence number. */
export type SessionSeq = number

/** Canonical JSON value accepted by the tool registry. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Durable compaction transaction summary read from the session log. */
export interface CompactionRecord extends Record<string, JsonValue> {
  compactionId: string
  seq: SessionSeq
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  shadowedSeqs: SessionSeq[]
  shadowedTokenCount: number
  provider: string
  model: string
  summaryText: string
  status: 'pending' | 'completed' | 'failed'
  summarySeq: SessionSeq
  endSeq: SessionSeq | null
  error?: string
}

/** Raw session event returned by sessionQuery. */
export interface SessionEventLike {
  readonly seq?: SessionSeq
  readonly type?: string
  readonly data?: unknown
  readonly time?: unknown
  readonly [key: string]: unknown
}

/** Structural view of the non-deprecated `ctx.sessionQuery` service. */
export interface SessionQueryLike {
  observeSession(sessionId: string, options?: Record<string, unknown>): Promise<SessionObservationLike> | SessionObservationLike
  listEvents?(sessionId: string): Promise<SessionEventRecordLike[]> | SessionEventRecordLike[]
  filterEvents?(sessionId: string, filters?: Record<string, unknown>): Promise<SessionSearchDocumentLike[]> | SessionSearchDocumentLike[]
  readSession?(sessionId: string): Promise<SessionLogSnapshotLike> | SessionLogSnapshotLike
}

export interface SessionObservationLike {
  readonly events: readonly SessionEventLike[]
  readonly [key: string]: unknown
}

export interface SessionEventRecordLike {
  readonly seq?: SessionSeq
  readonly surface?: string
  readonly type?: string
  readonly [key: string]: unknown
}

export interface SessionSearchDocumentLike {
  readonly seq?: SessionSeq
  readonly text?: string
  readonly surface?: string
  readonly type?: string
  readonly [key: string]: unknown
}

export interface SessionLogSnapshotLike {
  readonly events: readonly SessionEventLike[]
  readonly [key: string]: unknown
}

/** Minimal agent view needed for occupancy and workspace paths. */
export interface AgentLike {
  readonly session?: {
    readonly id?: string
    readonly surface?: { readonly nodes?: readonly SessionSeq[] }
    readonly eventAt?: (seq: SessionSeq) => SessionEventLike | undefined
  }
  readonly options?: {
    readonly cwd?: string
    readonly workspace?: string
  }
  readonly cwd?: string
  readonly workspace?: string
}

export interface CompactionToolOptions {
  readonly sessionQuery?: SessionQueryLike
  readonly exportRoot?: string
}

/** Tool error with an explicit code and user-facing message. */
export class ContextToolError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ContextToolError'
  }
}

interface PreparedTool {
  readonly sessionId: string
  readonly query: SessionQueryLike
  readonly events: readonly SessionEventLike[]
}

/**
 * Resolve and validate one execution's session query and full durable event
 * log. Fails explicitly for a missing service, missing session, or empty log.
 */
export async function prepareSessionQuery(
  ctx: Context,
  exec: ToolRunContext,
  agent?: AgentLike,
): Promise<PreparedTool> {
  const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (query === void 0 || typeof query.observeSession !== 'function') {
    throw new ContextToolError('ctx.sessionQuery is unavailable: install/enable @deepseek-ai/dsh-session-query (compaction history cannot be read without it)', 'SESSION_QUERY_UNAVAILABLE')
  }
  const sessionId = resolveSessionId(exec, agent)
  if (sessionId.length === 0) throw new ContextToolError('no session id is available on this execution', 'SESSION_ID_UNAVAILABLE')
  let observation: SessionObservationLike
  try {
    observation = await query.observeSession(sessionId)
  } catch (error) {
    throw new ContextToolError(`sessionQuery.observeSession("${sessionId}") failed: ${errorMessage(error)}`, 'SESSION_QUERY_READ_FAILED')
  }
  const events = Array.isArray(observation?.events) ? observation.events : []
  if (events.length === 0) {
    throw new ContextToolError(`session "${sessionId}" has no durable events; nothing can be inspected`, 'SESSION_EMPTY')
  }
  return { sessionId, query, events }
}

function resolveSessionId(exec: ToolRunContext, agent?: AgentLike): string {
  const candidate = (exec as { sessionId?: unknown }).session?.id
    ?? (exec as { sessionId?: unknown }).sessionId
    ?? agent?.session?.id
    ?? ''
  return typeof candidate === 'string' ? candidate : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Extract the event seq, accepting both top-level and nested seq fields. */
export function eventSeq(event: SessionEventLike): SessionSeq | null {
  const direct = event.seq
  if (typeof direct === 'number' && Number.isSafeInteger(direct)) return direct
  const data = event.data
  if (data !== null && typeof data === 'object') {
    const nested = (data as { seq?: unknown }).seq
    if (typeof nested === 'number' && Number.isSafeInteger(nested)) return nested
  }
  return null
}

/** Read the event's payload data. */
export function eventData(event: SessionEventLike): Record<string, unknown> {
  const data = event.data
  return data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
}

/** Render arbitrary JSON-ish content to compact text without throwing. */
export function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === void 0) return ''
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Collect summary text blocks from a compaction/summary payload. */
function summaryText(data: Record<string, unknown>): string {
  const summary = data.summary
  if (!Array.isArray(summary)) return stringify(summary)
  const parts: string[] = []
  for (const block of summary) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      parts.push(stringify((block as { text?: unknown }).text))
    }
  }
  return parts.join('\n')
}

function readRange(data: Record<string, unknown>): { start: SessionSeq; end: SessionSeq } {
  const range = data.shadowedRange
  const source = range !== null && typeof range === 'object' ? range as Record<string, unknown> : data
  return {
    start: typeof source.start === 'number' ? source.start : -1,
    end: typeof source.end === 'number' ? source.end : -1,
  }
}

function readSeqArray(data: Record<string, unknown>): SessionSeq[] {
  const seqs = data.shadowedSeqs
  return Array.isArray(seqs) ? seqs.filter((seq): seq is SessionSeq => typeof seq === 'number' && Number.isSafeInteger(seq)) : []
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : void 0
}

/**
 * Parse every durable compaction transaction into explicit records. Start and
 * summary events are merged by compactionId; a summary without start or an
 * unterminated transaction is reported with its exact status rather than being
 * dropped.
 */
export function collectCompactionRecords(events: readonly SessionEventLike[]): CompactionRecord[] {
  interface Pending { seq: SessionSeq; sourceCommandId?: string }
  const pending = new Map<string, Pending>()
  const records = new Map<string, CompactionRecord>()
  for (const event of events) {
    const seq = eventSeq(event)
    if (seq === null || typeof event.type !== 'string') continue
    const data = eventData(event)
    if (event.type === 'compaction/start') {
      const id = readOptionalText(data.compactionId)
      if (id === void 0) continue
      const sourceCommandId = readOptionalText(data.sourceCommandId)
      pending.set(id, sourceCommandId === void 0 ? { seq } : { seq, sourceCommandId })
    } else if (event.type === 'compaction/summary') {
      const id = readOptionalText(data.compactionId)
      if (id === void 0) continue
      const start = pending.get(id)
      const range = readRange(data)
      const record: CompactionRecord = {
        compactionId: id,
        seq: start?.seq ?? seq,
        shadowedRange: range,
        shadowedSeqs: readSeqArray(data),
        shadowedTokenCount: readNonNegativeNumber(data.shadowedTokenCount),
        provider: readOptionalText(data.provider) ?? '',
        model: readOptionalText(data.model) ?? '',
        summaryText: summaryText(data),
        status: 'pending',
        summarySeq: seq,
        endSeq: null,
      }
      if (start?.sourceCommandId !== void 0) record.sourceCommandId = start.sourceCommandId
      records.set(id, record)
    } else if (event.type === 'compaction/end') {
      const id = readOptionalText(data.compactionId)
      if (id === void 0) continue
      const record = records.get(id)
      if (record === void 0) continue
      record.endSeq = seq
      const error = readOptionalText(data.error)
      if (error === void 0) {
        record.status = 'completed'
      } else {
        record.status = 'failed'
        record.error = error
      }
    }
  }
  return [...records.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Count only current surface nodes and resolve their heuristic token cost
 * through the compaction engine's event-derived metric. The tool intentionally
 * derives the same `shadowedTokenCount` denominator shape as the official
 * engine: surface nodes are the payload, and occupancy is `sum(eventHeuristicTokens)`.
 */
export function surfaceStats(
  events: readonly SessionEventLike[],
  surfaceSeqs: readonly SessionSeq[],
): { occupied: number; nodeCount: number } {
  const bySeq = new Map<SessionSeq, SessionEventLike>()
  for (const event of events) {
    const seq = eventSeq(event)
    if (seq !== null) bySeq.set(seq, event)
  }
  let occupied = 0
  let nodeCount = 0
  for (const seq of surfaceSeqs) {
    const event = bySeq.get(seq)
    if (event === void 0) continue
    nodeCount += 1
    occupied += eventHeuristicTokens(event)
  }
  return { occupied, nodeCount }
}

/**
 * Heuristic token estimate matching the official compaction denominator's
 * event projection: message content blocks plus tool names and JSON arguments.
 */
export function eventHeuristicTokens(event: SessionEventLike): number {
  const data = eventData(event)
  const blocks = data.content
  let tokens = 0
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        tokens += textHeuristicTokens(stringify((block as { text?: unknown }).text))
      } else if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'toolUse') {
        tokens += textHeuristicTokens(stringify((block as { name?: unknown }).name))
        tokens += textHeuristicTokens(stringify((block as { input?: unknown }).input))
      } else if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'toolResult') {
        const result = (block as { content?: unknown }).content
        tokens += textHeuristicTokens(stringify(result))
      }
    }
  }
  return tokens
}

/** Conservative public estimate: ~4 Unicode characters per token. */
export function textHeuristicTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Resolve the official policy numbers without reading private engine state. */
export function readPolicy(
  compaction: unknown,
  event: SessionEventLike,
): { thresholdRatio: number; headroomTokens: number; occupied: number } {
  const source = compaction !== null && typeof compaction === 'object' ? compaction as Record<string, unknown> : {}
  const config = source.config !== null && typeof source.config === 'object' ? source.config as Record<string, unknown> : source
  const thresholdRatio = typeof config.thresholdRatio === 'number' ? config.thresholdRatio : 0.8
  const headroomTokens = typeof config.headroomTokens === 'number' ? config.headroomTokens : 0
  const occupied = typeof event.data === 'object' && event.data !== null
    ? readNonNegativeNumber((event.data as Record<string, unknown>).occupiedTokens)
    : 0
  return { thresholdRatio, headroomTokens, occupied }
}

function assertInteger(value: unknown, name: string): SessionSeq {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ContextToolError(`${name} must be a safe integer seq`, 'INVALID_SEQ')
  }
  return value
}

/** Validate a non-empty, bounded, integer seq range. */
export function parseRange(start: unknown, end: unknown): { start: SessionSeq; end: SessionSeq } {
  const from = assertInteger(start, 'start')
  const to = assertInteger(end, 'end')
  if (from < 0 || to < 0) throw new ContextToolError('start and end must be non-negative seq values', 'INVALID_RANGE')
  if (from > to) throw new ContextToolError(`invalid range: start ${from} is greater than end ${to}`, 'INVALID_RANGE')
  if (to - from > 10000) throw new ContextToolError(`range ${from}..${to} is too large (${to - from + 1} events; maximum is 10001)`, 'RANGE_TOO_LARGE')
  return { start: from, end: to }
}

/** Find every event in a validated range; missing seqs are returned explicitly. */
export function readEventRange(
  events: readonly SessionEventLike[],
  range: { start: SessionSeq; end: SessionSeq },
): { found: SessionEventLike[]; missing: SessionSeq[] } {
  const bySeq = new Map<SessionSeq, SessionEventLike>()
  for (const event of events) {
    const seq = eventSeq(event)
    if (seq !== null) bySeq.set(seq, event)
  }
  const found: SessionEventLike[] = []
  const missing: SessionSeq[] = []
  for (let seq = range.start; seq <= range.end; seq += 1) {
    const event = bySeq.get(seq)
    if (event === void 0) missing.push(seq)
    else found.push(event)
  }
  return { found, missing }
}

/** Render one durable event as readable export lines. */
export function formatEventForExport(event: SessionEventLike): string {
  const seq = eventSeq(event) ?? -1
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const data = eventData(event)
  return [
    `## seq ${seq} · ${type}`,
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n')
}

function resolveExportRoot(agent?: AgentLike, override?: string): string {
  if (typeof override === 'string' && override.trim().length > 0) return path.resolve(override)
  const candidate = agent?.options?.cwd ?? agent?.cwd ?? agent?.options?.workspace ?? agent?.workspace
  if (typeof candidate === 'string' && candidate.trim().length > 0) return path.resolve(candidate)
  throw new ContextToolError('no workspace cwd is available to hold the exported original; pass exportPath or run inside an agent with a cwd', 'WORKSPACE_UNAVAILABLE')
}

/** Reject path traversal and write the original text as UTF-8. */
export async function exportOriginal(
  agent: AgentLike | undefined,
  range: { start: SessionSeq; end: SessionSeq },
  events: readonly SessionEventLike[],
  exportPath?: string,
): Promise<string> {
  const root = resolveExportRoot(agent, exportPath === void 0 ? void 0 : path.dirname(path.resolve(exportPath)))
  const requested = exportPath === void 0
    ? path.join(root, `.dsh-context-compaction/original-${range.start}-${range.end}.md`)
    : path.resolve(exportPath)
  if (!isInside(root, requested)) {
    throw new ContextToolError(`export path ${requested} is outside workspace root ${root}`, 'EXPORT_PATH_OUTSIDE_WORKSPACE')
  }
  const header = [
    '# Compaction original (shadowed) events',
    '',
    `- source seq range: ${range.start}..${range.end}`,
    `- events read: ${events.length}`,
    '- Note: the host has no un-replace API. These events were NOT restored to the model-visible surface.',
    '- Read this file to inspect the original text; it remains a workspace artifact.',
    '',
  ].join('\n')
  const body = events.map(formatEventForExport).join('\n\n')
  await fs.mkdir(path.dirname(requested), { recursive: true })
  await fs.writeFile(requested, `${header}${body}\n`, 'utf8')
  return requested
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Parse a query into case-insensitive literal terms; regex syntax is literal. */
export function parseSearchQuery(query: string): string[] {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new ContextToolError('query must be a non-empty string', 'INVALID_QUERY')
  }
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter((term) => term.length > 0)
}

interface SearchHit {
  seq: SessionSeq
  surface: string
  type: string
  snippet: string
}

/** Search readable text from a set of events and return bounded hits. */
export function searchReadableEvents(
  events: readonly SessionEventLike[],
  terms: readonly string[],
  surface: string | null,
  limit: number,
): SearchHit[] {
  const hits: SearchHit[] = []
  for (const event of events) {
    if (hits.length >= limit) break
    const seq = eventSeq(event)
    if (seq === null) continue
    const text = readableEventText(event)
    const lower = text.toLocaleLowerCase()
    if (!terms.every((term) => lower.includes(term))) continue
    const snippet = makeSnippet(text, terms[0])
    hits.push({
      seq,
      surface: surface ?? 'log-only',
      type: typeof event.type === 'string' ? event.type : 'unknown',
      snippet,
    })
  }
  return hits
}

/** Extract all user-readable text from an event without assuming a projection API. */
export function readableEventText(event: SessionEventLike): string {
  const data = eventData(event)
  const parts: string[] = []
  const content = data.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        if ((block as { type?: unknown }).type === 'text') parts.push(stringify((block as { text?: unknown }).text))
        if ((block as { type?: unknown }).type === 'toolResult') parts.push(stringify((block as { content?: unknown }).content))
      }
    }
  }
  const text = data.text
  if (typeof text === 'string') parts.push(text)
  const message = data.message
  if (typeof message === 'string') parts.push(message)
  if (parts.length === 0) parts.push(stringify(data))
  return parts.join('\n')
}

function makeSnippet(text: string, term: string): string {
  const lower = text.toLocaleLowerCase()
  const at = Math.max(0, lower.indexOf(term) - 80)
  const end = Math.min(text.length, at + 320)
  return (at > 0 ? '…' : '') + text.slice(at, end).replace(/\s+/gu, ' ') + (end < text.length ? '…' : '')
}

/** Build the canonical context_status value. */
export function buildStatusValue(input: {
  sessionId: string
  config: { thresholdRatio: number; headroomTokens: number }
  occupied: number
  nodeCount: number
  records: readonly CompactionRecord[]
}): JsonValue {
  const thresholdTokens = Math.floor(input.occupied * input.config.thresholdRatio)
  const remaining = Math.max(0, thresholdTokens - input.occupied)
  return {
    sessionId: input.sessionId,
    occupancy: {
      occupiedTokens: input.occupied,
      visibleNodeCount: input.nodeCount,
      thresholdRatio: input.config.thresholdRatio,
      thresholdTokens,
      headroomTokens: input.config.headroomTokens,
      remainingTokensBeforeThreshold: remaining,
    },
    compactions: input.records.map((record) => {
      const compacted: Record<string, JsonValue> = {
        compactionId: record.compactionId,
        seq: record.seq,
        shadowedRange: { start: record.shadowedRange.start, end: record.shadowedRange.end },
        shadowedSeqs: [...record.shadowedSeqs],
        shadowedTokenCount: record.shadowedTokenCount,
        provider: record.provider,
        model: record.model,
        summary: record.summaryText,
        status: record.status,
        summarySeq: record.summarySeq,
        endSeq: record.endSeq,
      }
      if (record.error !== void 0) compacted.error = record.error
      return compacted
    }),
    note: 'Occupancy is an event-derived heuristic estimate, not the provider-billed token count. See context_expand for original events.',
  }
}

/** Build the canonical context_expand value. */
export function buildExpandValue(input: {
  sessionId: string
  range: { start: SessionSeq; end: SessionSeq }
  found: SessionEventLike[]
  missing: SessionSeq[]
  exportFile: string
}): JsonValue {
  return {
    sessionId: input.sessionId,
    range: { start: input.range.start, end: input.range.end },
    exportedFile: input.exportFile,
    eventCount: input.found.length,
    missingSeqs: [...input.missing],
    events: input.found.map((event) => ({
      seq: eventSeq(event) ?? -1,
      type: typeof event.type === 'string' ? event.type : 'unknown',
      data: normalizeJson(eventData(event)),
    })),
    surfaceRestore: false,
    notice: 'Original events were exported to the workspace file and were NOT restored to the model-visible surface; the host has no un-replace API. Read exportedFile to inspect the original text.',
  }
}

/** Build the canonical context_search value. */
export function buildSearchValue(input: {
  sessionId: string
  query: string
  surface: string
  hits: readonly SearchHit[]
  truncated: boolean
}): JsonValue {
  return {
    sessionId: input.sessionId,
    query: input.query,
    surface: input.surface,
    hitCount: input.hits.length,
    truncated: input.truncated,
    hits: input.hits.map((hit) => ({ seq: hit.seq, surface: hit.surface, type: hit.type, snippet: hit.snippet })),
    notice: 'Hits are durable events, not restored surface content. Use context_expand to export the original range.',
  }
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = normalizeJson(item)
    return result
  }
  return stringify(value)
}

/** Render a canonical value as one compact text block. */
export function renderText(value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Convert thrown errors to an explicit tool-error result. */
export function errorResult(error: unknown): { isError: true; content: ContentBlock[] } {
  const code = error instanceof ContextToolError ? error.code : 'UNEXPECTED_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text: `context tool error [${code}]: ${message}` }] }
}
