#!/usr/bin/env node
/**
 * sync-profile-patch.mjs — 把插件生成的 preset 段同步进 desktop profile 的
 * cordis.patch.yml，保留该文件里其他插件的内容不动。
 *
 * 为什么用脚本而不是手改：三段 preset 各 140+ 行，手改必然出错；且 patch
 * 语义是整行替换 config，漏抄一行即静默丢失插件。
 *
 * 策略：
 *   1. 读插件生成的 cordis.patch.yml，取出三段 `- id: preset-*` 块（含其上方注释）；
 *   2. 在 profile patch 里定位同样三段，逐段替换；
 *   3. profile 里预设之外的内容（其他插件行、value-router 等）原样保留。
 *
 * 用法：node scripts/sync-profile-patch.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SOURCE = join(ROOT, 'cordis.patch.yml')

const PROFILE = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml')
  : 'D:/DSHData/home/profiles/desktop/cordis.patch.yml'

const DRY_RUN = process.argv.includes('--dry-run')
const PRESETS = ['standard', 'cordis', 'ptc']

/**
 * 从文本里取出每一段 `- id: preset-*` 的**完整片段**，含其上连续的注释行。
 * 段落结束于下一个 `- id: ` 顶层行（或文件末尾）。
 * @param {string} text 完整 YAML 文本
 * @returns {Map<string, {start:number,end:number,text:string}>} 以 preset 名索引
 */
function extractPresetBlocks(text) {
  const lines = text.split(/\r?\n/)
  const found = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^- id: preset-([a-z]+)\s*$/.exec(lines[i])
    if (!m) continue
    const name = m[1]
    // 向上吃掉紧邻的注释行（本段自己的说明），遇到空行或代码行就停。
    let start = i
    while (start - 1 >= 0 && /^#/.test(lines[start - 1].trim())) start -= 1
    // 向下找到下一个顶层条目或文件末尾。
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^- /.test(lines[j])) { end = j; break }
    }
    // 去掉尾随空行，避免片段之间堆叠空行。
    let last = end
    while (last - 1 > i && lines[last - 1].trim() === '') last -= 1
    found.set(name, { start, end: last, text: lines.slice(start, last).join('\n') })
  }
  return found
}

if (!existsSync(SOURCE)) throw new Error(`插件生成的 patch 不存在: ${SOURCE}`)
if (!existsSync(PROFILE)) throw new Error(`profile patch 不存在: ${PROFILE}`)

const sourceText = readFileSync(SOURCE, 'utf8')
const profileText = readFileSync(PROFILE, 'utf8')

const sourceBlocks = extractPresetBlocks(sourceText)
const profileBlocks = extractPresetBlocks(profileText)

for (const name of PRESETS) {
  if (!sourceBlocks.has(name)) throw new Error(`插件 patch 缺少 preset-${name} 段`)
  if (!profileBlocks.has(name)) throw new Error(`profile patch 缺少 preset-${name} 段`)
}

// 从后往前替换，避免前面的替换影响后面的行号。
const order = PRESETS
  .map((name) => ({ name, ...profileBlocks.get(name) }))
  .sort((a, b) => b.start - a.start)

const profileLines = profileText.split(/\r?\n/)
for (const block of order) {
  const replacement = sourceBlocks.get(block.name).text.split('\n')
  console.log(`preset-${block.name}: 替换 profile L${block.start + 1}-L${block.end} (${block.end - block.start} 行) -> ${replacement.length} 行`)
  profileLines.splice(block.start, block.end - block.start, ...replacement)
}

const output = profileLines.join('\n')

if (DRY_RUN) {
  console.log('--- dry-run，未写入 ---')
} else {
  copyFileSync(PROFILE, `${PROFILE}.bak-sync`)
  writeFileSync(PROFILE, output, 'utf8')
  console.log(`已写入 ${PROFILE}（原文件备份为 .bak-sync）`)
}
