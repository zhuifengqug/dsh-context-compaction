/**
 * Retention-rule instruction tests: the built compaction instruction must
 * carry the acp-kernel-derived key-information retention rules (file paths,
 * commands, error text, user constraints, pending work) and the language
 * policy (Chinese summaries for Chinese conversations), with the layered
 * incremental addendum only when a prior checkpoint is present.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCompactionInstruction, detectPriorCheckpoint, dominantLanguage } from '../lib/instruction.js'

const CHINESE_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '帮我把 D:\\dsh-workspaces\\dev\\src\\index.ts 里的 compressSession 函数改掉，运行 pnpm run typecheck 时报错 TS2322。' }] },
  { role: 'assistant', content: [{ type: 'text', text: '已修复该报错并保留文件绝对路径原样。' }] },
]

const ENGLISH_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: 'Please fix the failing test in compressSession and rerun pnpm run typecheck; the error output says TS2322.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Fixed the failing test and kept the file path verbatim.' }] },
]

test('instruction carries verbatim retention rules for paths, commands, errors, and constraints', () => {
  const instruction = buildCompactionInstruction({ language: 'zh' })
  assert.match(instruction, /文件绝对路径/)
  assert.match(instruction, /命令原文/)
  assert.match(instruction, /报错文本原文/)
  assert.match(instruction, /用户硬性约束/)
  assert.match(instruction, /未决事项/)
  assert.match(instruction, /## Pending Jobs/)
  assert.match(instruction, /## Files and Code/)
  assert.match(instruction, /## Errors and Fixes/)
})

test('instruction keeps Chinese for zh conversations and English for en', () => {
  const zh = buildCompactionInstruction({ language: 'zh' })
  assert.match(zh, /摘要用简体中文撰写/)
  const en = buildCompactionInstruction({ language: 'en' })
  assert.match(en, /concise English engineering prose/)
})

test('auto language follows the dominant conversation language', () => {
  assert.equal(dominantLanguage(CHINESE_MESSAGES), 'zh')
  assert.equal(dominantLanguage(ENGLISH_MESSAGES), 'en')
})

test('incremental addendum appears only in incremental mode', () => {
  const incremental = buildCompactionInstruction({ incremental: true, language: 'zh' })
  assert.match(incremental, /增量模式：本区间内包含一份旧检查点/)
  assert.match(incremental, /分层增量合并/)
  const fresh = buildCompactionInstruction({ incremental: false, language: 'zh' })
  assert.doesNotMatch(fresh, /增量模式：本区间内包含一份旧检查点/)
  assert.match(fresh, /如果对话中已存在一个 <compacted-summary> 块/)
})

test('custom retention rules are appended verbatim', () => {
  const instruction = buildCompactionInstruction({ language: 'zh', retentionInstructions: ['保留 PR 编号与 commit 哈希。'] })
  assert.match(instruction, /- 保留 PR 编号与 commit 哈希。/)
})

test('prior checkpoint detection finds the tagged block', () => {
  const withCheckpoint = [
    ...CHINESE_MESSAGES,
    { role: 'user', content: [{ type: 'text', text: '前情：\n<compacted-summary>\n## Pending Jobs\n- 旧任务\n</compacted-summary>' }] },
  ]
  assert.match(detectPriorCheckpoint(withCheckpoint) ?? '', /旧任务/)
  assert.equal(detectPriorCheckpoint(CHINESE_MESSAGES), void 0)
})
