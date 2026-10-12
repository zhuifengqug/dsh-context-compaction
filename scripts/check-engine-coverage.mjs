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
  console.log('✓ 全部覆盖：卡片阈值在所有含 compaction 的 preset 上生效。')
  process.exit(0)
}
console.log(`✗ ${missing.length} 个 preset 未覆盖，其会话仍按官方默认 thresholdRatio 0.8 触发：`)
for (const r of missing) console.log(`   - ${r.preset}`)
process.exit(1)
