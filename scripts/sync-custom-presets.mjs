#!/usr/bin/env node
/**
 * sync-custom-presets.mjs — 把用户自建 preset 里的官方压缩引擎换成本插件。
 *
 * 为什么需要它：官方 preset（standard / cordis / ptc）由 profile 的 bundle
 * patch 覆盖，但用户在 `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml`
 * 下自建的 preset 不经过那条 patch 链，其中的
 * `name: '@deepseek-ai/dsh-compaction-basic'` 仍是官方引擎 —— 官方默认
 * thresholdRatio 0.8，设置卡片里调的阈值对它完全不生效。
 *
 * 只改 engine 行的 name，不写 config：阈值以
 * `$DSH_HOME/context-compaction.json` 为单一真源，由引擎构造时读取，
 * 避免同一数值在 preset 与配置文件两处各存一份而互相矛盾。
 *
 * 幂等：已是本插件引擎的行跳过。每个改动过的文件先备份为 .bak-engine。
 *
 * 用法：
 *   node scripts/sync-custom-presets.mjs            # 扫描并报告
 *   node scripts/sync-custom-presets.mjs --apply    # 实际写入
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const OFFICIAL_ENGINE = '@deepseek-ai/dsh-compaction-basic'
const PLUGIN_ENGINE = '@gjs27/dsh-context-compaction'
const APPLY = process.argv.includes('--apply')

/** 与其它脚本一致的 home 解析：非空 $DSH_HOME 优先，否则 ~/.dsh。 */
function resolveHome() {
  const configured = process.env.DSH_HOME
  const chosen = configured !== void 0 && configured.trim().length > 0
    ? configured
    : join(homedir(), '.dsh')
  return resolve(chosen)
}

const presetsRoot = join(resolveHome(), '.agent-presets')

/** 收集所有自建 preset 的 agent.cordis.yml。 */
function presetFiles() {
  if (!existsSync(presetsRoot)) return []
  const out = []
  for (const name of readdirSync(presetsRoot)) {
    const dir = join(presetsRoot, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const file = join(dir, 'agent.cordis.yml')
    if (existsSync(file)) out.push({ name, file })
  }
  return out
}

/**
 * 在文本里把 compaction 引擎行的 name 换成本插件。
 * 只认「上一行是 `- id: compaction-basic`」的那个 name，避免误伤注释或其它引用。
 * @param text - preset 文件全文。
 * @returns `{ text, changed }`，changed 为 false 表示无需改动。
 */
function rewriteEngineName(text) {
  const lines = text.split(/\r?\n/)
  let changed = false
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s+id:\s*compaction-basic\s*$/.test(lines[i])) continue
    const next = i + 1
    if (next >= lines.length) continue
    const m = /^(\s*)name:\s*'([^']+)'\s*$/.exec(lines[next])
    if (!m) continue
    if (m[2] === PLUGIN_ENGINE) continue
    if (m[2] !== OFFICIAL_ENGINE) {
      console.log(`  ! 未识别的引擎名，跳过：${m[2]}`)
      continue
    }
    lines[next] = `${m[1]}name: '${PLUGIN_ENGINE}'`
    changed = true
  }
  return { text: lines.join('\n'), changed }
}

const files = presetFiles()
if (files.length === 0) {
  console.log(`未找到自建 preset：${presetsRoot}`)
  process.exit(0)
}

console.log(`扫描 ${presetsRoot}`)
console.log(`模式：${APPLY ? '写入' : '只读（加 --apply 才写入）'}\n`)

let touched = 0
for (const { name, file } of files) {
  const original = readFileSync(file, 'utf8')
  const hasOfficial = original.includes(OFFICIAL_ENGINE)
  const hasPlugin = original.includes(PLUGIN_ENGINE)
  const { text, changed } = rewriteEngineName(original)

  if (!changed) {
    const state = hasPlugin ? '已是本插件引擎' : '无 compaction 引擎行'
    console.log(`[跳过] ${name} — ${state}`)
    continue
  }

  console.log(`[${APPLY ? '改写' : '待改写'}] ${name}`)
  console.log(`        ${file}`)
  if (APPLY) {
    copyFileSync(file, `${file}.bak-engine`)
    writeFileSync(file, text, 'utf8')
    console.log('        已写入，原文件备份为 .bak-engine')
  }
  touched += 1
}

console.log(`\n合计 ${touched} 个 preset ${APPLY ? '已改写' : '待改写'}。`)
if (!APPLY && touched > 0) console.log('确认无误后加 --apply 执行。')
