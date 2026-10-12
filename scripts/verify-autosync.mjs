/**
 * Live proof that preset autosync is automatic.
 *
 * Starts the real installed autosync (the same module the engine loads) against
 * a throwaway DSH home, then creates a brand-new preset file WITHOUT calling any
 * sync function. If the file switches to this plugin's engine on its own, the
 * automatic channel works.
 *
 * The autosync resolves its roots from `$DSH_HOME`, so the throwaway home is
 * installed as `$DSH_HOME` for the live phase and restored afterwards. The
 * real home is then checked separately to prove the scanned roots and path
 * patterns match the actual profile layout.
 *
 * Usage: node scripts/verify-autosync.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPresetAutosync, syncPresetEngines, OFFICIAL_ENGINE, PLUGIN_ENGINE, resolveDshHome } from '../lib/preset-autosync.js'

const BODY = (engine) => `- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '${engine}'
`

const realHome = resolveDshHome()
const home = mkdtempSync(join(tmpdir(), 'cc-live-'))
const created = []

// The autosync watches whatever $DSH_HOME names; point it at the throwaway home.
process.env.DSH_HOME = home
installPresetAutosync({ logger: { info: (...a) => console.log('[autosync]', ...a), warn: (...a) => console.log('[warn]', ...a) } })

// Give the watcher a moment to attach before anything appears.
await new Promise((r) => setTimeout(r, 400))

// 1. A NEW active preset appears — the watcher alone must handle it.
const active = join(home, '.agent-presets', 'brandnew', 'agent.cordis.yml')
mkdirSync(join(active, '..'), { recursive: true })
writeFileSync(active, BODY(OFFICIAL_ENGINE), 'utf8')
created.push(active)

// 2. A NEW template appears under a profile's node_modules.
const template = join(home, 'profiles', 'desktop', 'node_modules', 'some-plugin', 'preset', 'agent.cordis.yml')
mkdirSync(join(template, '..'), { recursive: true })
writeFileSync(template, BODY(OFFICIAL_ENGINE), 'utf8')
created.push(template)

// Wait past the debounce with no manual sync call of any kind.
await new Promise((r) => setTimeout(r, 4000))

const check = (file, what) => {
  const text = readFileSync(file, 'utf8')
  const ok = text.includes(PLUGIN_ENGINE) && !text.includes(OFFICIAL_ENGINE)
  console.log(`${ok ? '✓' : '✗'} ${what}自动改写：${ok ? '是' : '否'}`)
  return ok
}

const okActive = check(active, '新建自建 preset（监视器即时通道）')

// Template roots are covered by the periodic sweep rather than a watcher: that
// tree holds every profile's node_modules, so watching it recursively would cost
// far more than it buys. Wait out one sweep interval.
console.log('… 等待一次兜底扫描周期（模板由扫描覆盖，非监视器）')
await new Promise((r) => setTimeout(r, 17_000))
const okTemplate = check(template, '新建模板（兜底扫描通道）')

// 3. The real home must report nothing pending — proves paths match reality.
process.env.DSH_HOME = realHome
const real = syncPresetEngines(realHome)
const realOk = real.rewritten.length === 0 && real.errors.length === 0
console.log(`${realOk ? '✓' : '✗'} 真实 DSH_HOME 无待改写项（已覆盖 ${real.already.length} 个，错误 ${real.errors.length} 个）`)

rmSync(home, { recursive: true, force: true })

const pass = okActive && okTemplate && realOk
console.log(pass ? '\n结果：自动覆盖成立（新建 preset 无需手动同步）' : '\n结果：自动覆盖未成立')
process.exit(pass ? 0 : 1)
