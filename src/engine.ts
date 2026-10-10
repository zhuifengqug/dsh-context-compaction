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
    super(ctx, base)
    this.plugin = resolvePluginConfig({ retentionInstructions, incremental, summaryLanguage })
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
