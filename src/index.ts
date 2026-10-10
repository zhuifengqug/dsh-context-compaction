/**
 * @gjs27/dsh-context-compaction — native context compaction engine for DSH.
 *
 * Extends the official `BasicCompactionEngine` and overrides its sole
 * subclass hook `summarize(input, agent, signal)` to provide:
 *
 * 1. Layered incremental summarization: when the shadowed region already
 *    contains a prior `<compacted-summary>` checkpoint, the summarizer is
 *    instructed to merge the still-true facts of the prior checkpoint with
 *    newer information into one consolidated checkpoint — the compressed
 *    prior summary is the context input, the original pre-compaction
 *    history is never replayed (the official surface-replace mechanism
 *    already guarantees that).
 * 2. Key-information retention rules (adopted from acp-kernel's MIT
 *    compaction rules, without its runtime): verbatim file paths, code
 *    identifiers, command lines, error text, user constraints, and pending
 *    work; Chinese conversations get Chinese summaries with technical
 *    tokens kept verbatim.
 * 3. Plugin-level config keys `retentionInstructions`, `incremental`, and
 *    `summaryLanguage`, layered over the official 11-key BasicCompactionConfig
 *    (official keys are forwarded to the parent constructor untouched; the
 *    official threshold/retain/headroom policy keeps full effect, including
 *    the parent's "summary must be smaller" hard check, which is NOT bypassed).
 *
 * Earlier, tunable triggering is pure configuration of the official policy
 * keys (`thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens`)
 * and therefore works unchanged; see README for recommended values.
 *
 * @module @gjs27/dsh-context-compaction
 */

import { ContextCompactionEngine, type ContextCompactionConfig } from './engine.ts'
import { PLUGIN_CONFIG_KEYS, resolvePluginConfig, type PluginExtraConfig } from './config.ts'
import { detectPriorCheckpoint, dominantLanguage, buildCompactionInstruction } from './instruction.ts'

export {
  ContextCompactionEngine,
  ContextCompactionEngine as default,
  type ContextCompactionConfig,
}
export { PLUGIN_CONFIG_KEYS, resolvePluginConfig, type PluginExtraConfig }
export { detectPriorCheckpoint, dominantLanguage, buildCompactionInstruction }

/** Cordis service identity kept identical to the official engine row. */
export const name = 'compaction-basic'

export type { ContextCompactionConfig as CompactionEngineConfig }

/** Re-export the inject list contract (same services as the official engine). */
export const inject = ContextCompactionEngine.inject
export type { Context as CordisContext } from '@deepseek-ai/cordis'
