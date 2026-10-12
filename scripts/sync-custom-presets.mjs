#!/usr/bin/env node
/**
 * sync-custom-presets.mjs — 把承载压缩引擎的 preset 全部换成本插件。
 *
 * 为什么需要它：DSH 里压缩引擎有两个来源，覆盖路径不同，漏一个那个 preset
 * 下的会话就仍按官方 thresholdRatio 0.8 触发，表现像「设置没生效」。
 *
 *   1. 官方 preset（standard / cordis / ptc）在 DSH 安装树里 —— 由本插件的
 *      bundle patch 整行替换 config，不需要本脚本。
 *   2. 其余位置的 preset 都不走那条 patch 链，必须直接改文件：
 *      · $DSH_HOME/.agent-presets/<name>/agent.cordis.yml  —— 活跃的自建 preset
 *      · 各插件在自身 node_modules 里附带的 preset 源文件/模板 —— 未来自建
 *        preset 的复制来源，不处理则「新建的 preset 一出生就是官方引擎」
 *
 * 只改 engine 行的 `name`，不写 config：阈值以
 * $DSH_HOME/context-compaction.json 为单一真源，避免同一数值两处各存一份。
 *
 * 幂等；每个改动过的文件先备份为 .bak-engine。
 *
 * 用法：
 *   node scripts/sync-custom-presets.mjs                     # 扫描并报告
 *   node scripts/sync-custom-presets.mjs --apply             # 写入
 *   node scripts/sync-custom-presets.mjs --apply --templates # 连模板一起写入
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const OFFICIAL_ENGINE = '@deepseek-ai/dsh-compaction-basic'
const PLUGIN_ENGINE = '@gjs27/dsh-context-compaction'

const APPLY = process.argv.includes('--apply')
const WITH_TEMPLATES = process.argv.includes('--templates')

function resolveHome() {
  const configured = process.env.DSH_HOME
  const chosen = configured !== void 0 && configured.trim().length > 0 ? configured : join(homedir(), '.dsh')
  return resolve(chosen)
}

const home = resolveHome()
const presetsRoot = join(home, '.agent-presets')
const profileModules = join(home, 'profiles', 'desktop', 'node_modules')

/** 活跃自建 preset：一个子目录一个 preset。 */
function activePresetFiles() {
  if (!existsSync(presetsRoot)) return []
  const out = []
  for (const name of readdirSync(presetsRoot)) {
    const dir = join(presetsRoot, name)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    const file = join(dir, 'agent.cordis.yml')
    if (existsSync(file)) out.push({ label: `自建 ${name}`, file, kind: 'active' })
  }
  return out
}

/**
 * 插件附带的 preset 源文件/模板：profile node_modules 下、名字像 preset 的 yml。
 * 这些是未来自建 preset 的复制来源，处理它们等于「新 preset 一出生就带本插件引擎」。
 */
function templateFiles() {
  const out = []
  if (!existsSync(profileModules)) return out
  const patterns = [
    /preset[\\/]agent\.cordis\.yml$/,
    /presets[\\/][^\\/]+[\\/]agent\.cordis\.yml$/,
    /preset\.generated\.patch\.yml$/,
  ]
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' && depth > 0) continue
        walk(p, depth + 1)
        continue
      }
      if (!/\.ya?ml$/.test(e.name)) continue
      if (!patterns.some((re) => re.test(p))) continue
      out.push({ label: p.replace(profileModules, '…node_modules'), file: p, kind: 'template' })
    }
  }
  walk(profileModules, 0)
  return out
}

/**
 * 把 compaction 引擎行的 name 换成本插件。
 * 只认「上一行是 `- id: compaction-basic`」的那个 name，避免误伤注释或其它引用。
 * @param text - preset 文件全文。
 * @returns `{ text, changed }`。
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
      console.log(`        ! 未识别的引擎名，跳过：${m[2]}`)
      continue
    }
    lines[next] = `${m[1]}name: '${PLUGIN_ENGINE}'`
    changed = true
  }
  return { text: lines.join('\n'), changed }
}

const active = activePresetFiles()
const templates = WITH_TEMPLATES ? templateFiles() : []
const targets = [...active, ...templates]

console.log(`自建 preset：${presetsRoot}`)
console.log(`模板源文件：${WITH_TEMPLATES ? profileModules : '（加 --templates 才扫描）'}`)
console.log(`模式：${APPLY ? '写入' : '只读（加 --apply 才写入）'}\n`)

let touched = 0
for (const t of targets) {
  const original = readFileSync(t.file, 'utf8')
  const { text, changed } = rewriteEngineName(original)
  if (!changed) {
    const state = original.includes(PLUGIN_ENGINE) ? '已是本插件引擎' : '无 compaction 引擎行'
    console.log(`[跳过] ${t.label} — ${state}`)
    continue
  }
  console.log(`[${APPLY ? '改写' : '待改写'}] ${t.label}`)
  if (APPLY) {
    copyFileSync(t.file, `${t.file}.bak-engine`)
    writeFileSync(t.file, text, 'utf8')
    console.log('        已写入，备份 .bak-engine')
  }
  touched += 1
}

console.log(`\n合计 ${touched} 个${APPLY ? '已改写' : '待改写'}。`)
if (!APPLY && touched > 0) console.log('确认无误后加 --apply 执行。')
if (WITH_TEMPLATES && APPLY) {
  console.log('注意：模板位于其它插件的 node_modules 内，该插件升级/重装会还原它们；')
  console.log('      届时重跑本脚本，或用 scripts/check-engine-coverage.mjs 复查。')
}
