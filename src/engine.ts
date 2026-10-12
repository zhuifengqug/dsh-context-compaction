/**
 * The context compaction engine: `BasicCompactionEngine` with a custom
 * `summarize()` hook. All official mechanisms are inherited untouched —
 * pre-step pressure triggering, context-overflow recovery, the durable
 * compaction lock, surface replace, compactionRetries, and the
 * toolResultPruner cooperation — and the parent's "summary must be smaller"
 * hard check stays fully in force (it is never bypassed).
 *
 * @module @gjs27/dsh-context-compaction/engine
 */

import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine, type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, LlmError, contentHasImage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { resolvePluginConfig, type ResolvedPluginConfig, type SummaryLanguage } from './config.ts'
import { registerVisibilityTools, type ToolContextOptions } from './tools.ts'
import { registerSettingsEndpoint, readStoredSettingsSync } from './settings-endpoint.ts'
import { installPresetAutosync, type AutosyncContext as AutosyncHostContext } from './preset-autosync.ts'
import { resolvePolicy, toEngineConfig, fromDocument } from './threshold-settings.ts'

/** Structural view of the realm context the visibility tools need. */
type ToolContextLike = Parameters<typeof registerVisibilityTools>[0] & ToolContextOptions

/** Structural view of the host context the settings endpoint needs. */
type SettingsHostContextLike = Parameters<typeof registerSettingsEndpoint>[0]

/**
 * Merge the saved threshold policy over the config the preset supplied,
 * preserving the official mutual exclusion between `retainRatio` and
 * `retainTokens`.
 *
 * The parent's `validatePolicy` rejects a config carrying both keys, so a naive
 * spread would break construction whenever the caller pinned `retainTokens`
 * with a number. Whichever retention key the saved settings resolve to wins,
 * and the other one is dropped rather than left behind.
 *
 * @param base - config the preset patch supplied.
 * @param saved - validated settings read from the card's file.
 * @returns config safe for the parent constructor.
 */
export function mergeThresholds(base: Record<string, unknown>, saved: unknown) {
  // Accept both the persisted envelope ({version, settings}) and bare settings,
  // so a caller cannot accidentally pass the wrong shape and get `undefined`
  // threshold keys. `fromDocument` also rejects out-of-range values.
  const settings = fromDocument(saved)
  // No usable saved settings means "no override": the preset's own config
  // passes through untouched, so a caller-pinned retainTokens keeps working.
  if (settings === void 0) return { ...base }
  const { policy } = resolvePolicy(settings)
  const engine = toEngineConfig(policy)
  const merged: Record<string, unknown> = { ...base, ...engine }
  if ('retainTokens' in engine) delete merged.retainRatio
  else delete merged.retainTokens
  return merged
}

/**
 * Read the card's saved thresholds without ever throwing.
 *
 * Construction must not fail because of a settings file: an unreadable or
 * malformed file simply means "no override", and compaction keeps working on
 * the policy the preset patch supplied.
 * @returns saved settings, or `undefined` when absent/unusable.
 */
function safeReadSaved() {
  try {
    return readStoredSettingsSync()
  } catch {
    return void 0
  }
}

/** Minimal logger surface used for non-fatal registration warnings. */
interface OptionalLogger {
  readonly logger?: { warn?: (message: string, ...args: unknown[]) => void }
}

/**
 * Structural mirrors of the official `SummarizationInput` / `SummaryResult`
 * (the npm package does not export these type-only subpaths). Structural
 * compatibility keeps the override assignable to the parent hook.
 */

/** Replayed conversation prefix the summarizer condenses. */
interface SummarizationInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope. */
type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & ({
  rawOutput: ContentBlock[]
  llmStreamCall: true
} | {
  rawOutput?: ContentBlock[]
  llmStreamCall?: never
})
import { buildCompactionInstruction, detectPriorCheckpoint, dominantLanguage } from './instruction.ts'

/**
 * Plugin configuration: the official 11 `BasicCompactionConfig` keys plus
 * the three plugin-level keys. The official keys are forwarded to the parent
 * constructor (whose `resolveConfig` validates them); the plugin keys are
 * validated here. This mirrors the parent's `Config` schema shape so the
 * Loader receives one consistent schema.
 */
export type ContextCompactionConfig = BasicCompactionConfig & import('./config.ts').PluginExtraConfig

/** Terminal summarization finish mapped to its fail-closed error. */
function finishError(finish: { kind: string; failure?: { message: string; code: string } }): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure?.message ?? 'summarization failed', finish.failure?.code ?? 'SUMMARIZATION_FAILED')
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      ;(error as Error & { code?: string }).code = 'MAX_TOKENS'
      return error
    }
    default:
      return void 0
  }
}

/** Keep only text blocks; reject visual output before synthesizing the summary. */
function summaryText(blocks: readonly ContentBlock[]): Extract<ContentBlock, { type: 'text' }>[] {
  if (contentHasImage([...blocks])) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

/**
 * Compaction engine with layered incremental summarization and
 * key-information retention rules. Extends the official engine and overrides
 * ONLY `summarize`; every other mechanism, config key, and hard check is the
 * official one.
 */
export class ContextCompactionEngine extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions']

  static override Config: z<ContextCompactionConfig> = z.object({
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: z.number(),
      headroomTokens: z.number().step(1).min(0),
      retainRatio: z.number(),
      retainTokens: z.number().step(1).min(0),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
    })),
    auto: z.boolean(),
    retentionInstructions: z.array(z.string()),
    incremental: z.boolean(),
    summaryLanguage: z.union(['auto', 'zh', 'en'] as const),
  })

  /** Validated plugin-level settings. */
  readonly plugin: ResolvedPluginConfig

  constructor(ctx: Context, config: ContextCompactionConfig = {}) {
    const { retentionInstructions, incremental, summaryLanguage, ...base } = config
    // The settings card owns the tunable policy: its saved file, when present,
    // overrides the threshold keys the preset patch supplied. That keeps the
    // card authoritative without needing an official config-editor write path,
    // which cannot address an engine row nested inside a preset.
    const saved = safeReadSaved()
    const withSaved = mergeThresholds(base as Record<string, unknown>, saved)
    super(ctx, withSaved as ContextCompactionConfig)
    this.plugin = resolvePluginConfig({ retentionInstructions, incremental, summaryLanguage })
    // The compaction realm owns these registrations: a Cordis plugin class has no
    // `setup` lifecycle hook, so the constructor (and ctx.effect) is the only
    // place they can be installed. Registering here also keeps the tools inside
    // the same realm as the engine, so `ctx.tools` / `ctx.sessionQuery` resolve.
    this.installRegistrations(ctx)
  }

  /**
   * Install this plugin's session tools, the settings-card endpoint, and the
   * preset-engine autosync.
   * @param ctx - the engine's owning context.
   */
  private installRegistrations(ctx: Context): void {
    const logger = (ctx as unknown as OptionalLogger).logger
    try {
      ctx.effect(() => registerVisibilityTools(ctx as unknown as ToolContextLike), 'context-compaction: tools')
    } catch (error) {
      // A tooling realm without `ctx.tools` must not break compaction itself.
      logger?.warn?.('context-compaction: visibility tools not registered: %s', String((error as Error)?.message ?? error))
    }
    try {
      registerSettingsEndpoint(ctx as unknown as SettingsHostContextLike)
    } catch (error) {
      logger?.warn?.('context-compaction: settings endpoint not registered: %s', String((error as Error)?.message ?? error))
    }
    try {
      // Presets the user authors, and the templates other plugins ship, name
      // the engine inside their own static files and never pass through this
      // plugin's bundle patch. Without this, such a preset keeps the official
      // engine whose thresholdRatio is 0.8 and the settings card looks inert.
      installPresetAutosync(ctx as unknown as AutosyncHostContext)
    } catch (error) {
      logger?.warn?.('context-compaction: preset autosync not started: %s', String((error as Error)?.message ?? error))
    }
  }

  /**
   * Summarize the replayed region with the plugin instruction: retention
   * rules, language policy, and layered incremental merging when a prior
   * checkpoint is present. The result shape matches the official contract
   * exactly; optional fields are omitted (never `undefined`) because session
   * event data must stay JSON-serializable.
   * @param input - replayed conversation prefix to condense.
   * @param agent - agent whose routed model supplies the summarization target.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks plus the call envelope.
   */
  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const target = resolveSummarizationTarget(agent, this.config)
    const prior = this.plugin.incremental ? detectPriorCheckpoint(input.messages) : void 0
    const language: SummaryLanguage = this.plugin.summaryLanguage === 'auto' ? dominantLanguage(input.messages) : this.plugin.summaryLanguage
    const instruction = buildCompactionInstruction({
      incremental: prior !== void 0,
      language,
      retentionInstructions: this.plugin.retentionInstructions,
    })

    const assembler = new BlockAssembler()
    const messages: Message[] = [...input.messages, {
      role: 'user',
      content: [{ type: 'text', text: instruction }],
    }] as Message[]
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === void 0 ? {} : { tools: [...input.tools] as ToolSchema[] }),
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction' as const,
      ...(signal === void 0 ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== void 0) throw error
    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some((block) => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
    const usage: TokenUsage | undefined = assembler.usage
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: this.config.maxTokens,
      ...(usage === void 0 ? {} : { usage }),
    }
  }
}

/**
 * Resolve the summarization target exactly like the official hook: the
 * explicit pair, else the latest durable routed request, else the agent
 * options pair. Throws when nothing is available (never returns undefined
 * fields downstream).
 */
function resolveSummarizationTarget(
  agent: Agent,
  config: { summarizationProvider: string; summarizationModel: string },
): { provider: string; model: string } {
  const configured = config.summarizationProvider.length === 0
    ? void 0
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const latest = agent.session.requestHeader()?.config
  const latestPair = latest !== void 0 && latest.provider.length > 0 && latest.model.length > 0
    ? { provider: latest.provider, model: latest.model }
    : void 0
  const agentPair = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : void 0
  const target = configured ?? latestPair ?? agentPair
  if (target === void 0) {
    throw new Error('no provider/model available for summarization: set both summarization fields, route one request, or set both AgentOptions fields')
  }
  return target
}

export { errorChain }
