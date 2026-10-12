#!/usr/bin/env node
/**
 * check-engine-coverage.mjs — 回答一个问题：设置卡片里的阈值，在哪些 preset 上真正生效？
 *
 * 压缩引擎有两个可能的位置，覆盖方式不同，容易漏掉一半：
 *   1. 官方 preset（standard / cordis / ptc）：源文件在 DSH 安装树里，永远是官方引擎；
 *      由 profile 的 bundle patch 整行替换 config 来覆盖。
 *   2. 用户自建 preset（$DSH_HOME/.agent-presets/<name>/agent.cordis.yml）：
 *      不走那条 patch 链，必须直接改文件（scripts/sync-custom-presets.mjs）。
 *
 * 漏掉第 2 类的表现极具迷惑性：卡片能开、能存，但该 preset 下的会话仍按
 * 官方 0.8 触发，看起来像「设置没生效」。
 *
 * 用法：node scripts/check-engine-coverage.mjs
 * 退出码：0 = 全部覆盖；1 = 存在未覆盖的 preset。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const OFFICIAL_ENGINE = '@deepseek-ai/dsh-compaction-basic'
const PLUGIN_ENGINE = '@gjs27/dsh-context-compaction'

/** 官方 preset 快照目录（安装树，只读）。 */
const OFFICIAL_DIR = 'D:/Deepseek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-web-app/presets'

function resolveHome() {
  const configured = process.env.DSH_HOME
  const chosen = configured !== void 0 && configured.trim().length > 0 ? configured : join(homedir(), '.dsh')
  return resolve(chosen)
}

const home = resolveHome()
const profilePatch = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
const customRoot = join(home, '.agent-presets')

const rows = []

/** 官方 preset：源文件是官方引擎，看 profile patch 是否覆盖了它。 */
if (existsSync(OFFICIAL_DIR)) {
  const patch = existsSync(profilePatch) ? readFileSync(profilePatch, 'utf8') : ''
  for (const name of readdirSync(OFFICIAL_DIR)) {
    const m = /^([a-z]+)\.patch\.yml$/.exec(name)
    if (!m) continue
    const preset = m[1]
    const text = readFileSync(join(OFFICIAL_DIR, name), 'utf8')
    const hasGroup = text.includes('compaction: true')
    if (!hasGroup) {
      rows.push({ preset: `官方 ${preset}`, engine: '无 compaction 组', ok: true, how: '不需要覆盖' })
      continue
    }
    const covered = patch.includes(`- id: preset-${preset}`)
    rows.push({
      preset: `官方 ${preset}`,
      engine: covered ? PLUGIN_ENGINE : OFFICIAL_ENGINE,
      ok: covered,
      how: covered ? 'profile patch 整行替换' : '未覆盖 —— profile patch 缺少该段',
    })
  }
}

/** 自建 preset：直接看文件内容。 */
if (existsSync(customRoot)) {
  for (const dir of readdirSync(customRoot)) {
    const file = join(customRoot, dir, 'agent.cordis.yml')
    if (!existsSync(file)) continue
    try { if (!statSync(file).isFile()) continue } catch { continue }
    const text = readFileSync(file, 'utf8')
    if (!text.includes('compaction: true')) {
      rows.push({ preset: `自建 ${dir}`, engine: '无 compaction 组', ok: true, how: '不需要覆盖' })
      continue
    }
    const hasPlugin = text.includes(PLUGIN_ENGINE)
    const hasOfficial = text.includes(OFFICIAL_ENGINE)
    rows.push({
      preset: `自建 ${dir}`,
      engine: hasPlugin && !hasOfficial ? PLUGIN_ENGINE : (hasOfficial ? OFFICIAL_ENGINE : '(未识别)'),
      ok: hasPlugin && !hasOfficial,
      how: hasPlugin && !hasOfficial ? '直接改写 preset 文件' : '未覆盖 —— 跑 scripts/sync-custom-presets.mjs --apply',
    })
  }
}

if (rows.length === 0) {
  console.log('未找到任何 preset。')
  process.exit(1)
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0)))
console.log('preset 压缩引擎覆盖总览')
console.log('='.repeat(78))
console.log(`${pad('preset', 16)} ${pad('实际引擎', 34)} 说明`)
console.log('-'.repeat(78))
for (const r of rows) {
  console.log(`${pad(r.ok ? '✓' : '✗', 4)}${pad(r.preset, 14)} ${pad(r.engine, 34)} ${r.how}`)
}

const missing = rows.filter((r) => !r.ok)
console.log('-'.repeat(78))
if (missing.length === 0) {
  console.log('✓ 活跃 preset 全部覆盖：卡片阈值在所有含 compaction 的 preset 上生效。')
} else {
  console.log(`✗ ${missing.length} 个活跃 preset 未覆盖，其会话仍按官方默认 thresholdRatio 0.8 触发：`)
  for (const r of missing) console.log(`   - ${r.preset}（${r.how}）`)
}

// ── 未来 preset 的来源模板 ────────────────────────────────────────────────
// 这些文件不是活跃 preset，但新建/重装 preset 时会被复制或应用。
// 它们被插件升级还原后不会影响当前会话，却会让「下一个新建的 preset」
// 一出生就带官方引擎 —— 所以单独列出来。
const templateRows = []
const modulesDir = join(home, 'profiles', 'desktop', 'node_modules')
if (existsSync(modulesDir)) {
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
      const text = readFileSync(p, 'utf8')
      if (!text.includes('compaction: true') && !text.includes('compaction-basic')) continue
      const hasPlugin = text.includes(PLUGIN_ENGINE)
      const hasOfficial = text.includes(OFFICIAL_ENGINE)
      templateRows.push({
        file: p.replace(modulesDir, '…node_modules'),
        ok: hasPlugin && !hasOfficial,
      })
    }
  }
  walk(modulesDir, 0)
}

if (templateRows.length > 0) {
  console.log('')
  console.log('未来 preset 的来源模板（不是活跃 preset，但决定新建/重装 preset 用什么引擎）')
  console.log('-'.repeat(78))
  for (const r of templateRows) {
    console.log(`${r.ok ? '✓' : '✗'}  ${r.file}`)
  }
  const badTemplates = templateRows.filter((r) => !r.ok)
  if (badTemplates.length > 0) {
    console.log(`✗ ${badTemplates.length} 个模板仍是官方引擎 —— 新建的 preset 会继承它：`)
    console.log('   node scripts/sync-custom-presets.mjs --apply --templates')
  } else {
    console.log('✓ 模板全部已换为本插件：新建的 preset 会直接继承本插件引擎。')
  }
}

const templateMissing = templateRows.filter((r) => !r.ok)
console.log('-'.repeat(78))
if (missing.length === 0 && templateMissing.length === 0) {
  console.log('✓ 全覆盖：活跃 preset 与来源模板都已使用本插件引擎。')
  process.exit(0)
}
if (missing.length > 0) {
  console.log('✗ 存在未覆盖的活跃 preset，其会话不按卡片阈值压缩。')
  process.exit(1)
}
console.log('△ 活跃 preset 已全覆盖；但有来源模板仍是官方引擎（影响未来新建的 preset）。')
process.exit(0)
