/**
 * Three native DSH tools for compaction visibility and rollback:
 *
 * - `context_status`: model-facing current occupancy, configured threshold,
 *   headroom, and the durable compacted intervals.
 * - `context_expand`: read shadowed original events by seq range through
 *   `ctx.sessionQuery` and export them to a workspace file. The host has no
 *   un-replace API; the result explicitly says the original was not restored
 *   to the model-visible surface and must be read from the exported file.
 * - `context_search`: search only shadowed events and return hits with seq.
 *
 * The tools are registered in the same preset compaction realm as the engine.
 * `session.eventAt` is deprecated and is not the main path; all rollback
 * reads go through `ctx.sessionQuery`.
 *
 * @module @gjs27/dsh-context-compaction/visibility
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Session sequence number. */
export type SessionSeq = number

/** Canonical JSON value accepted by the tool registry. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Durable compaction transaction summary read from the session log. */
export interface CompactionRecord {
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
  sourceCommandId?: string
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
}

export interface SessionObservationLike {
  readonly events: readonly SessionEventLike[]
  readonly [key: string]: unknown
}

/** Minimal agent view needed for occupancy and workspace paths. */
export interface AgentLike {
  readonly session?: {
    readonly id?: string
    readonly surface?: { readonly nodes?: readonly SessionSeq[] }
  }
  readonly options?: { readonly cwd?: string; readonly workspace?: string }
  readonly cwd?: string
  readonly workspace?: string
}

export interface TokenMeterLike {
  measure(session: unknown): { readonly totalTokens?: unknown; readonly nodes?: readonly { readonly heuristicTokens?: unknown }[] }
}

export interface CompactionServiceLike {
  readonly config?: {
    readonly thresholdRatio?: unknown
    readonly headroomTokens?: unknown
  }
}

export interface ToolContextOptions {
  readonly sessionQuery?: SessionQueryLike
  readonly tokenMeter?: TokenMeterLike
  readonly compaction?: CompactionServiceLike
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
  readonly events: readonly SessionEventLike[]
  readonly session: unknown
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

/** Resolve and validate one execution's session query and full durable log. */
export async function prepareSessionQuery(
  ctx: Context,
  exec: ToolRunContext,
  agent?: AgentLike,
  options?: ToolContextOptions,
): Promise<PreparedTool> {
  const query = options?.sessionQuery ?? ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (query === void 0 || typeof query.observeSession !== 'function') {
    throw new ContextToolError('ctx.sessionQuery is unavailable: enable @deepseek-ai/dsh-session-query so compaction history can be read', 'SESSION_QUERY_UNAVAILABLE')
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
  if (events.length === 0) throw new ContextToolError(`session "${sessionId}" has no durable events; nothing can be inspected`, 'SESSION_EMPTY')
  return { sessionId, events, session: (observation as { session?: unknown }).session }
}

function resolveSessionId(exec: ToolRunContext, agent?: AgentLike): string {
  const execution = exec as unknown as { session?: { readonly id?: unknown }; sessionId?: unknown }
  const candidate = (execution.session !== null && typeof execution.session === 'object' ? execution.session.id : void 0)
    ?? execution.sessionId
    ?? agent?.session?.id
    ?? ''
  return typeof candidate === 'string' ? candidate : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
 * summary events are merged by compactionId; an unterminated or failed
 * transaction keeps its exact status rather than being dropped.
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

/** Resolve official pressure policy numbers without private engine access. */
export function readPolicy(
  compaction: CompactionServiceLike | undefined,
): { thresholdRatio: number; headroomTokens: number } {
  const config = compaction?.config
  return {
    thresholdRatio: typeof config?.thresholdRatio === 'number' ? config.thresholdRatio : 0.8,
    headroomTokens: typeof config?.headroomTokens === 'number' ? config.headroomTokens : 65536,
  }
}

/** Measure current model-visible pressure exactly as the official engine does. */
export function readOccupancy(
  tokenMeter: TokenMeterLike | undefined,
  session: unknown,
): { totalTokens: number; visibleNodeCount: number } {
  const measurement = tokenMeter?.measure(session)
  const totalTokens = typeof measurement?.totalTokens === 'number' ? measurement.totalTokens : 0
  const visibleNodeCount = Array.isArray(measurement?.nodes) ? measurement.nodes.length : 0
  return { totalTokens, visibleNodeCount }
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
  return [
    `## seq ${seq} · ${type}`,
    '```json',
    JSON.stringify(eventData(event), null, 2),
    '```',
  ].join('\n')
}

function resolveWorkspaceRoot(agent?: AgentLike, exportPath?: string): string {
  const candidate = agent?.options?.cwd ?? agent?.cwd ?? agent?.options?.workspace ?? agent?.workspace
  if (typeof candidate === 'string' && candidate.trim().length > 0) return path.resolve(candidate)
  if (exportPath !== void 0) return path.dirname(path.resolve(exportPath))
  throw new ContextToolError('no workspace cwd is available to hold the exported original; pass exportPath or run inside an agent with a cwd', 'WORKSPACE_UNAVAILABLE')
}

/** Reject path traversal and write the original text as UTF-8. */
export async function exportOriginal(
  agent: AgentLike | undefined,
  range: { start: SessionSeq; end: SessionSeq },
  events: readonly SessionEventLike[],
  exportPath?: string,
): Promise<string> {
  const requested = exportPath === void 0
    ? path.join(resolveWorkspaceRoot(agent), `.dsh-context-compaction/original-${range.start}-${range.end}.md`)
    : path.resolve(exportPath)
  const root = resolveWorkspaceRoot(agent, requested)
  if (!isInside(root, requested)) {
    throw new ContextToolError(`export path ${requested} is outside workspace root ${root}`, 'EXPORT_PATH_OUTSIDE_WORKSPACE')
  }
  const header = [
    '# Compaction original (shadowed) events',
    '',
    `- source seq range: ${range.start}..${range.end}`,
    `- events read: ${events.length}`,
    '- The host has no un-replace API. These events were NOT restored to the model-visible surface.',
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

/** How a hit's durability surface is classified relative to compaction. */
export type SearchSurfaceFilter = 'shadowed' | 'all'

/** Search readable text from a set of events and return bounded hits.
 *
 * `surfaceOf` classifies each event (typically 'shadowed' vs 'log-only').
 * `filter` decides which classes may be returned: `'shadowed'` keeps only
 * events the compaction records actually shadowed, `'all'` keeps every
 * readable event. The filter is applied BEFORE the limit is consumed, so a
 * bounded result is never silently filled with events the caller excluded.
 */
export function searchReadableEvents(
  events: readonly SessionEventLike[],
  terms: readonly string[],
  surface: string | null | ((event: SessionEventLike) => string),
  limit: number,
  filter: SearchSurfaceFilter = 'all',
): SearchHit[] {
  const hits: SearchHit[] = []
  for (const event of events) {
    if (hits.length >= limit) break
    const seq = eventSeq(event)
    if (seq === null) continue
    const resolvedSurface = typeof surface === 'function' ? surface(event) : (surface ?? 'log-only')
    if (filter === 'shadowed' && resolvedSurface !== 'shadowed') continue
    const text = readableEventText(event)
    const lower = text.toLocaleLowerCase()
    if (!terms.every((term) => lower.includes(term))) continue
    hits.push({
      seq,
      surface: resolvedSurface,
      type: typeof event.type === 'string' ? event.type : 'unknown',
      snippet: makeSnippet(text, terms[0]),
    })
  }
  return hits
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

/** Build the canonical context_status value. */
export function buildStatusValue(input: {
  sessionId: string
  policy: { thresholdRatio: number; headroomTokens: number }
  occupancy: { totalTokens: number; visibleNodeCount: number }
  records: readonly CompactionRecord[]
}): JsonValue {
  // NOTE: this is deliberately NOT named `thresholdTokens`. The real trigger
  // point is floor(min(contextWindow * thresholdRatio,
  // contextWindow - reservedOutput - headroomTokens)) — a function of the
  // routed model's WINDOW, not of current occupancy. This tool cannot resolve
  // the window (that needs ctx.llm.resolveModelInfo, unavailable from a tool
  // body), so multiplying occupancy by the ratio would produce a number that
  // drifts with occupancy and is NOT the threshold. Exposing it as a
  // ratio-scaled reference avoids reporting a fake trigger point.
  const occupancyRatioReference = Math.floor(input.occupancy.totalTokens * input.policy.thresholdRatio)
  return {
    sessionId: input.sessionId,
    occupancy: {
      totalTokens: input.occupancy.totalTokens,
      visibleNodeCount: input.occupancy.visibleNodeCount,
      thresholdRatio: input.policy.thresholdRatio,
      occupancyRatioReference,
      headroomTokens: input.policy.headroomTokens,
      note: 'Occupancy is the official tokenMeter.measure(session).totalTokens pressure estimate, not a provider billing record.',
      thresholdNote: 'The real auto-compaction trigger is floor(min(contextWindow * thresholdRatio, contextWindow - reservedOutput - headroomTokens)), computed by the official engine from the routed model window. occupancyRatioReference above is totalTokens * thresholdRatio — a ratio-scaled reference that CHANGES with occupancy and is NOT the trigger point.',
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
    note: 'Use context_expand to read a shadowed range and context_search to find text inside it.',
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

function agentFrom(exec: ToolRunContext): AgentLike | undefined {
  const agent = (exec as { agent?: unknown }).agent
  return agent !== null && typeof agent === 'object' ? agent as AgentLike : void 0
}

function execSignal(exec: ToolRunContext): AbortSignal | undefined {
  const signal = (exec as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : void 0
}

/**
 * Build and register `context_status`, `context_expand`, and `context_search`
 * on `ctx.tools`. The definitions use the official `defineTool` shape:
 * `name` / `description` / `parameters` / `output.schema` / `output.render`
 * / `execute`.
 */
export function registerVisibilityTools(ctx: Context, options?: ToolContextOptions): () => void {
  const runtimeOptions: ToolContextOptions = {
    sessionQuery: options?.sessionQuery ?? (ctx.get('sessionQuery') as SessionQueryLike | undefined),
    tokenMeter: options?.tokenMeter ?? (ctx.get('tokenMeter') as TokenMeterLike | undefined),
    compaction: options?.compaction ?? (ctx.get('compaction') as CompactionServiceLike | undefined),
  }
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'context_status',
      description: 'Show the current context occupancy, the configured threshold policy (ratio + headroom), and every compacted interval in this session. Use this before deciding whether an old topic has been compacted. Note: the real auto-compaction trigger is computed by the official engine from the routed model window; this tool cannot resolve that window, so it reports the policy numbers and a ratio-scaled reference rather than a trigger point.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderText(value),
      },
      async execute(_args, exec) {
        try {
          const prepared = await prepareSessionQuery(ctx, exec, agentFrom(exec), runtimeOptions)
          const records = collectCompactionRecords(prepared.events)
          const policy = readPolicy(runtimeOptions.compaction)
          const occupancy = readOccupancy(runtimeOptions.tokenMeter, prepared.session)
          return buildStatusValue({ sessionId: prepared.sessionId, policy, occupancy, records })
        } catch (error) {
          return errorValue(error)
        }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'context_expand',
      description: 'Read the original events shadowed by compaction for an inclusive seq range and export them to a workspace file. The host has no un-replace API: this tool never restores the original to the model-visible surface; read the exported file to inspect the original text.',
      parameters: {
        start: { type: 'integer', required: true, description: 'Inclusive first session seq of the original range.' },
        end: { type: 'integer', required: true, description: 'Inclusive last session seq of the original range.' },
        exportPath: { type: 'string', description: 'Optional workspace-relative or absolute .md path for the exported original events.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderText(value),
      },
      async execute(args, exec) {
        try {
          const prepared = await prepareSessionQuery(ctx, exec, agentFrom(exec), runtimeOptions)
          const range = parseRange(args.start, args.end)
          const { found, missing } = readEventRange(prepared.events, range)
          if (found.length === 0) throw new ContextToolError(`no events found for seq range ${range.start}..${range.end}; verify the range against context_status or context_search`, 'SEQ_NOT_FOUND')
          const exportFile = await exportOriginal(agentFrom(exec), range, found, args.exportPath)
          return buildExpandValue({ sessionId: prepared.sessionId, range, found, missing, exportFile })
        } catch (error) {
          return errorValue(error)
        }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'context_search',
      description: 'Search readable text in this session and report matching events with their seq and snippet. Pass surface=shadowed to search only original events hidden by compaction; pass surface=all to search every durable event.',
      parameters: {
        query: { type: 'string', required: true, description: 'Case-insensitive literal search terms; regex syntax is treated as literal text.' },
        surface: { type: 'string', enum: ['shadowed', 'all'], default: 'shadowed', description: 'Which durable event set to search.' },
        limit: { type: 'integer', default: 20, description: 'Maximum number of hits to return (1-100).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderText(value),
      },
      async execute(args, exec) {
        try {
          const prepared = await prepareSessionQuery(ctx, exec, agentFrom(exec), runtimeOptions)
          const terms = parseSearchQuery(args.query)
          const surface = args.surface === 'all' ? 'all' : 'shadowed'
          const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0
            ? Math.min(args.limit, 100)
            : 20
          const shadowedSeqs = new Set(collectCompactionRecords(prepared.events).flatMap((record) => record.shadowedSeqs))
          // A shadowed surface node may be referenced by `shadowedSeqs` while
          // the durable event wrapper itself is log-only; therefore classify
          // over the full durable log, then let the filter drop non-shadowed
          // events when surface='shadowed' (the default).
          const candidates = prepared.events
          const surfaceOf = (event: SessionEventLike): string => {
            const seq = eventSeq(event)
            return seq !== null && shadowedSeqs.has(seq) ? 'shadowed' : 'log-only'
          }
          const hits = searchReadableEvents(candidates, terms, surfaceOf, limit, surface)
          return buildSearchValue({ sessionId: prepared.sessionId, query: args.query, surface, hits, truncated: hits.length >= limit })
        } catch (error) {
          return errorValue(error)
        }
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Render a thrown tool error as a canonical error value. Tool bodies do not
 * return `isError`; the registry's error path renders the thrown message, so
 * every failure is explicit and actionable rather than silent.
 */
function errorValue(error: unknown): JsonValue {
  const code = error instanceof ContextToolError ? error.code : 'UNEXPECTED_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  throw new ContextToolError(`${message} [${code}]`, code)
}

export type { ToolDefinition, ToolRunContext }
