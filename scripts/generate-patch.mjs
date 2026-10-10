#!/usr/bin/env node
/**
 * generate-patch.mjs — 从 snapshots/ 精确派生 cordis.patch.yml 的替换体。
 *
 * 为什么不手抄：patch 引擎对匹配行是**整行替换 config、绝不深合并**，
 * 漏抄任一顶层插件行即静默丢失该插件。手抄 19-20 行 × 3 个 preset 风险高、
 * 且宿主升级后必然失效。改为程序化派生：
 *   1. 读 snapshots/<name>.patch.yml（官方原文，未改一字）；
 *   2. 只把 compaction 组内的 `compaction-basic` 行替换为本插件行；
 *   3. 其余内容（注释、缩进、!!js 表达式、isolate 映射）**逐字保留**。
 *
 * 产出：cordis.patch.yml（三段 - id: preset-* / config: <patched config>）
 *
 * 用法：node scripts/generate-patch.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SNAPSHOT_DIR = join(ROOT, 'snapshots')

/** 覆盖范围的 preset（与 verify-composition.mjs 的 COVERED 保持一致）。 */
const COVERED = ['standard', 'cordis', 'ptc']
/** 本插件的包名——替换掉官方 compaction-basic 行的 name。 */
const ENGINE_PACKAGE = '@gjs27/dsh-context-compaction'

/**
 * 把官方 preset 原文的 `plugins:` 块提取为一个「行数组」，保留逐字内容，
 * 使输出能原样嵌进 cordis.patch.yml 的 config.plugins。
 *
 * 策略：定位 `plugins:` 行，取其下所有缩进更深的行（含空行与注释），
 * 整体缩进提升一级（-4 空格→按 config 层级对齐）。
 */
function extractPluginsBlock(text) {
  const lines = text.split(/\r?\n/)
  let start = -1
  let pluginsIndent = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*plugins:\s*$/.test(lines[i])) { start = i; pluginsIndent = lines[i].length - lines[i].trimStart().length; break }
  }
  if (start === -1) throw new Error('未找到 plugins: 块')
  const block = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') { block.push(line); continue }
    const indent = line.length - line.trimStart().length
    if (indent <= pluginsIndent) break
    block.push(line)
  }
  return { block, pluginsIndent }
}

/** 读取 config.id / config.order 的原文值（保留引号与否的写法）。 */
function readScalar(text, key) {
  const m = new RegExp(`^\\s{2,}${key}:\\s*(.+)$`, 'm').exec(text)
  return m ? m[1].trim() : null
}

/**
 * 在插件块内定位 compaction 组下的 compaction-basic 行，替换为本插件行。
 * 只在 isolate:{compaction:true,...} 组内的那一行生效——该行是
 * `- id: compaction-basic` 且紧随其后是 name: '@deepseek-ai/dsh-compaction-basic'。
 */
function replaceEngineRow(block) {
  const out = []
  let replaced = 0
  for (let i = 0; i < block.length; i += 1) {
    const line = block[i]
    if (/^\s*-\s+id:\s*compaction-basic\s*$/.test(line)) {
      const nextIdx = i + 1
      const next = nextIdx < block.length ? block[nextIdx] : ''
      if (/^\s*name:\s*'@deepseek-ai\/dsh-compaction-basic'\s*$/.test(next)) {
        out.push(line)
        const indent = next.length - next.trimStart().length
        out.push(`${' '.repeat(indent)}name: '${ENGINE_PACKAGE}'`)
        i = nextIdx
        replaced += 1
        continue
      }
    }
    out.push(line)
  }
  if (replaced !== 1) throw new Error(`compaction-basic 行替换次数异常: ${replaced}（期望恰好 1 次）`)
  return out
}

const HEADER = `# @gjs27/dsh-context-compaction — preset 挂载层（自动生成，勿手改）
#
# 生成方式：node scripts/generate-patch.mjs
# 内容来源：snapshots/<preset>.patch.yml（官方原文快照，逐字保留）
#
# 为什么必须整行替换 preset 的 config（而非插一行到 compaction 组内）：
#   1. patch 阶段——preset 内部行不在 Loader 的 id 索引里（applyEntryPatches
#      只在 group:true 时递归），任何 \`insert\` 到预设内部行的尝试都报
#      "entry not found"；
#   2. 运行阶段——compaction 组的 \`isolate: {compaction: true}\` 是 LocalRealm
#      私有 symbol，顶层 context 永远解析不到其服务；
#   3. 且 patch 引擎对匹配行是**整行替换 config、绝不深合并**（config 整体
#      赋值），因此**必须完整重述 config.id / config.order / config.plugins**，
#      漏抄任一行即静默丢失该插件。
#
# 因此本文件把三个 preset 的 config 整体重述一遍，仅在 compaction 隔离组内
# 把官方 compaction-basic 换成 @gjs27/dsh-context-compaction。
#
# ⚠️ DSH 升级后必须重跑：node scripts/verify-composition.mjs
#    结构漂移时它会 exit 1；此时需重拷快照并重新生成本文件。
#
# 覆盖范围（t1 裁定）：preset-standard（默认）+ preset-cordis（本机实测在用）
#   + preset-ptc；preset-minimal 无 compaction 组，不需要覆盖。
`

const parts = [HEADER]
for (const name of COVERED) {
  const snapPath = join(SNAPSHOT_DIR, `${name}.patch.yml`)
  if (!existsSync(snapPath)) throw new Error(`快照缺失: ${snapPath}`)
  const text = readFileSync(snapPath, 'utf8')
  const configId = readScalar(text, 'id')
  const order = readScalar(text, 'order')
  if (configId === null || order === null) throw new Error(`${name}: 无法解析 config.id / config.order`)
  const { block } = extractPluginsBlock(text)
  const patched = replaceEngineRow(block)

  parts.push(`
- id: preset-${name}
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: ${configId}
    order: ${order}
    plugins:
${patched.join('\n')}
`)
}

const outPath = join(ROOT, 'cordis.patch.yml')
writeFileSync(outPath, parts.join('\n'), 'utf8')
console.log(`已生成 ${outPath}`)
console.log(`覆盖 preset: ${COVERED.join(', ')}（engine 行 → ${ENGINE_PACKAGE}）`)
