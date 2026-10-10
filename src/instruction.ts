/**
 * Summarizer instruction construction — pure functions, no DSH imports, so
 * `node --test` can exercise the built `lib/` directly.
 *
 * The checkpoint structure mirrors the official `COMPACTION_INSTRUCTION`
 * section headers (kept in English for format compatibility with prior
 * checkpoints), while the rules section adopts the acp-kernel compaction
 * rules (MIT): verbatim file paths, code identifiers, command lines, error
 * text, user constraints, and pending work; Chinese conversations keep
 * Chinese summaries.
 *
 * @module @gjs27/dsh-context-compaction/instruction
 */

import type { SummaryLanguage } from './config.ts'

const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** CJK share above which a conversation counts as Chinese under `auto`. */
const CJK_RATIO_THRESHOLD = 0.12

/** Minimum text characters before a language vote is meaningful. */
const MIN_CHARS_FOR_LANGUAGE_VOTE = 32

/** Section headers shared by first-shot and incremental checkpoints. */
const CHECKPOINT_SECTIONS = [
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
].join('\n')

/** Shared retention rules (acp-kernel-derived; verbatim-preserving). */
const RETENTION_RULES = [
  '保留规则（必须逐条遵守）:',
  '- 逐字保留文件绝对路径（如 D:\\dsh-workspaces\\dev\\src\\index.ts），不得改写或省略目录层级。',
  '- 逐字保留代码标识符：函数名、类名、变量名、配置键、API 端点、npm 包名。',
  '- 逐字保留命令原文（shell 命令、脚本调用、命令行参数），保留退出码与执行结果要点。',
  '- 逐字保留报错文本原文（错误消息、错误码、异常类型、栈要点），保留「报错→处置」的对应关系。',
  '- 忠实记录用户硬性约束与明确指令，尤其是纠正性反馈；关键措辞逐字引用。',
  '- 未决事项一节不得留空为 "(none)"，除非对话中确实没有任何未完成请求。',
  '- 数值、版本号、URL、分支名、commit 哈希保持原样。',
].join('\n')

/** Language directive per summary language mode. */
const LANGUAGE_RULES: Record<Exclude<SummaryLanguage, 'auto'>, string> = {
  zh: '- 摘要用简体中文撰写；文件路径、命令、报错原文、代码与专有名词保持原文，不翻译。',
  en: '- Write concise English engineering prose; keep paths, commands, error strings, and identifiers verbatim.',
}

/**
 * Incremental-mode addendum: merge the prior checkpoint instead of replaying
 * or copying it, so each compaction round compresses the delta only.
 */
const INCREMENTAL_ADDENDUM = [
  '增量模式：本区间内包含一份旧检查点（<compacted-summary> 块）。执行分层增量合并：',
  `- 旧检查点是此前压缩的产物，不要原样照抄，也不要在其中以外重新罗列旧区间原文。`,
  '- 保留旧检查点中仍然成立的事实，删除已被后续对话推翻或完成的条目。',
  '- 把本区间的新信息合并进对应小节，输出一份统一的合并检查点。',
  '- 旧检查点中仍有效的关键细节（路径、命令、报错、约束、未决事项）不得丢失。',
  `- 输出中仍使用 ${SUMMARY_OPEN_TAG} 与 ${SUMMARY_CLOSE_TAG} 的成对结构之外，只输出检查点正文本身。`,
].join('\n')

/** Collect the text of every text block across the given messages. */
export function messageTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown } | null | undefined)?.content
    if (typeof content === 'string') {
      texts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block === 'string') {
        texts.push(block)
        continue
      }
      const typed = block as { type?: unknown; text?: unknown } | null
      if (typed !== null && typeof typed === 'object' && typed.type === 'text' && typeof typed.text === 'string') texts.push(typed.text)
    }
  }
  return texts
}

/**
 * Detect a prior compaction checkpoint inside the shadowed region.
 * @param messages - replayed region messages (may include the checkpoint node).
 * @returns the full text of the first message carrying a checkpoint, or `undefined`.
 */
export function detectPriorCheckpoint(messages: readonly unknown[]): string | undefined {
  for (const text of messageTexts(messages)) {
    if (text.includes(SUMMARY_OPEN_TAG)) return text
  }
  return void 0
}

/** Count of Han characters in a text. */
function hanCharCount(text: string): number {
  const matches = text.match(/\p{Script=Han}/gu)
  return matches === null ? 0 : matches.length
}

/** Count of ASCII letters/digits in a text (used to weight technical tokens). */
function asciiCharCount(text: string): number {
  const matches = text.match(/[A-Za-z0-9]/g)
  return matches === null ? 0 : matches.length
}

/**
 * Decide the dominant conversation language from the replayed messages.
 * Chinese is elected when the Han-character share over the CJK+ASCII vote
 * pool clears {@link CJK_RATIO_THRESHOLD}; very short inputs fall back to `zh`
 * because the product's primary sessions are Chinese.
 * @param messages - replayed region messages.
 * @returns the elected summary language mode.
 */
export function dominantLanguage(messages: readonly unknown[]): Exclude<SummaryLanguage, 'auto'> {
  const texts = messageTexts(messages)
  let han = 0
  let ascii = 0
  for (const text of texts) {
    han += hanCharCount(text)
    ascii += asciiCharCount(text)
  }
  const total = han + ascii
  if (total < MIN_CHARS_FOR_LANGUAGE_VOTE) return 'zh'
  return han / total >= CJK_RATIO_THRESHOLD ? 'zh' : 'en'
}

/**
 * Build the final compaction instruction delivered as the last user message.
 * @param options - incremental flag, language mode, and extra retention rules.
 * @returns the instruction text (JSON-safe: plain string, no undefined parts).
 */
export function buildCompactionInstruction(options: {
  incremental?: boolean
  language?: SummaryLanguage
  retentionInstructions?: readonly string[]
} = {}): string {
  const incremental = options.incremental ?? false
  const language = options.language ?? 'auto'
  const extraRules = options.retentionInstructions ?? []
  const lines: string[] = [
    '你是本 AI 编码助手的压缩引擎。把上方的对话压缩成一份结构化检查点，让另一个模型可以在不丢失关键上下文的情况下继续工作。',
    '',
    '严格按照以下 Markdown 结构输出：保留全部小节并按原顺序排列；使用简短条目而非成段文字；空小节写 "(none)"——不得删除小节。',
    '',
    CHECKPOINT_SECTIONS,
    '',
    RETENTION_RULES,
  ]
  if (language !== 'auto') lines.push(LANGUAGE_RULES[language])
  for (const rule of extraRules) lines.push(`- ${rule.trim()}`)
  lines.push(
    '- 不要提及本次摘要请求本身，也不要提及上下文被压缩。',
    '- 只输出检查点文本：不调用任何工具，不做其他动作。',
  )
  if (incremental) {
    lines.push('', INCREMENTAL_ADDENDUM)
  } else {
    lines.push(
      '',
      `- 如果对话中已存在一个 ${SUMMARY_OPEN_TAG} 块，它是旧检查点：不要原样照抄——保留仍然成立的事实，删除过时内容，把新信息合并成一份统一摘要，保持同样的结构。`,
    )
  }
  return lines.join('\n')
}

export const SUMMARY_TAGS = { open: SUMMARY_OPEN_TAG, close: SUMMARY_CLOSE_TAG }
