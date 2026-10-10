/**
 * Plugin-level configuration keys layered over the official
 * `BasicCompactionConfig`. The official 11 keys are validated by the parent
 * class `resolveConfig`; this module validates only the three new keys and
 * rejects unknown ones early with the same error style.
 *
 * @module @gjs27/dsh-context-compaction/config
 */

/** Plugin-level keys this engine adds over `BasicCompactionConfig`. */
export const PLUGIN_CONFIG_KEYS = [
  'retentionInstructions',
  'incremental',
  'summaryLanguage',
] as const

export type SummaryLanguage = 'auto' | 'zh' | 'en'

/** Plugin-level extension of the official `BasicCompactionConfig`. */
export interface PluginExtraConfig {
  /**
   * Extra verbatim-retention rules appended to the summarizer instruction,
   * one rule per entry. Use them to protect project-specific details
   * (e.g. "保留 PR 编号" or "preserve crontab expressions").
   */
  readonly retentionInstructions?: string[]
  /**
   * Enable layered incremental summarization: a prior `<compacted-summary>`
   * checkpoint inside the shadowed region is merged instead of being copied
   * forward. Defaults to `true`.
   */
  readonly incremental?: boolean
  /**
   * Summary language: `auto` follows the conversation's dominant language
   * (Chinese conversations get Chinese summaries), `zh` forces Chinese,
   * `en` forces English. Technical tokens (paths, commands, errors) stay
   * verbatim in every mode. Defaults to `auto`.
   */
  readonly summaryLanguage?: SummaryLanguage
}

/** Validated plugin-level settings resolved from {@link PluginExtraConfig}. */
export interface ResolvedPluginConfig {
  readonly retentionInstructions: readonly string[]
  readonly incremental: boolean
  readonly summaryLanguage: SummaryLanguage
}

/**
 * Validate and resolve the plugin-level keys.
 * @param config - untrusted plugin-level subset after stripping official keys.
 * @returns detached immutable resolved settings.
 */
export function resolvePluginConfig(config: PluginExtraConfig = {}): ResolvedPluginConfig {
  const { retentionInstructions, incremental, summaryLanguage } = config
  if (retentionInstructions !== void 0) {
    if (!Array.isArray(retentionInstructions)) throw new Error('ContextCompactionConfig: retentionInstructions must be an array of strings')
    for (const rule of retentionInstructions) {
      if (typeof rule !== 'string' || rule.trim().length === 0) throw new Error('ContextCompactionConfig: every retentionInstructions entry must be a non-empty string')
    }
  }
  if (incremental !== void 0 && typeof incremental !== 'boolean') throw new Error('ContextCompactionConfig: incremental must be a boolean')
  if (summaryLanguage !== void 0 && summaryLanguage !== 'auto' && summaryLanguage !== 'zh' && summaryLanguage !== 'en') {
    throw new Error('ContextCompactionConfig: summaryLanguage must be one of "auto" | "zh" | "en"')
  }
  return {
    retentionInstructions: retentionInstructions === void 0 ? [] : [...retentionInstructions],
    incremental: incremental ?? true,
    summaryLanguage: summaryLanguage ?? 'auto',
  }
}
