/**
 * Preset-engine autosync tests.
 *
 * The behaviour under test is what makes the settings card work on presets the
 * plugin does not ship: a preset's compaction engine is named inside its own
 * static file, so anything outside the bundle patch keeps the official engine
 * (thresholdRatio 0.8) unless it is rewritten. These tests pin the rewrite
 * boundaries (only the engine row's name, nothing else) and the pass semantics
 * (idempotent, backed up once, tolerant of unreadable targets).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OFFICIAL_ENGINE,
  PLUGIN_ENGINE,
  collectTargets,
  isPresetPath,
  rewriteEngineName,
  syncPresetEngines,
} from '../lib/preset-autosync.js'

const PRESET_BODY = (engine) => `- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '${engine}'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
`

/** Build a throwaway DSH home with the given preset files. */
function makeHome(files) {
  const home = mkdtempSync(join(tmpdir(), 'cc-autosync-'))
  for (const [relative, body] of Object.entries(files)) {
    const file = join(home, relative)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body, 'utf8')
  }
  return home
}

test('rewriteEngineName switches the engine row and reports the change', () => {
  const { text, changed } = rewriteEngineName(PRESET_BODY(OFFICIAL_ENGINE))
  assert.equal(changed, true)
  assert.match(text, new RegExp(`- id: compaction-basic\\n      name: '${PLUGIN_ENGINE.replace('/', '\\/')}'`))
  assert.equal(text.includes(OFFICIAL_ENGINE), false)
})

test('rewriteEngineName leaves an already-switched preset untouched', () => {
  const original = PRESET_BODY(PLUGIN_ENGINE)
  const { text, changed } = rewriteEngineName(original)
  assert.equal(changed, false)
  assert.equal(text, original)
})

test('rewriteEngineName does not touch a comment that merely names the package', () => {
  const body = `# compaction-basic reads toolResultPrune through ctx.get\n${PRESET_BODY(OFFICIAL_ENGINE)}`
  const { text } = rewriteEngineName(body)
  // The comment survives verbatim; only the engine row's name changed.
  assert.equal(text.includes('# compaction-basic reads toolResultPrune through ctx.get'), true)
  assert.equal(text.split('\n').filter((l) => l.includes(OFFICIAL_ENGINE)).length, 0)
})

test('rewriteEngineName ignores an unrecognised engine name', () => {
  const body = PRESET_BODY('@someone/other-engine')
  const { text, changed } = rewriteEngineName(body)
  assert.equal(changed, false)
  assert.equal(text, body)
})

test('rewriteEngineName is a no-op when the id row has no name line', () => {
  const body = '- id: compaction-basic\n- id: something-else\n'
  const { text, changed } = rewriteEngineName(body)
  assert.equal(changed, false)
  assert.equal(text, body)
})

test('isPresetPath matches preset definitions and generated preset patches only', () => {
  assert.equal(isPresetPath('/home/.agent-presets/redteam/agent.cordis.yml'), true)
  assert.equal(isPresetPath('/profile/node_modules/dsh-purge/presets/redteam/agent.cordis.yml'), true)
  assert.equal(isPresetPath('/profile/node_modules/dsh-custom-mode/preset/agent.cordis.yml'), true)
  assert.equal(isPresetPath('/profile/node_modules/@adwmc/helm-d/preset.generated.patch.yml'), true)
  assert.equal(isPresetPath('/profile/cordis.patch.yml'), false)
  assert.equal(isPresetPath('/profile/node_modules/x/package.json'), false)
})

test('syncPresetEngines rewrites a new preset, backs it up once, and is idempotent', () => {
  const home = makeHome({
    '.agent-presets/redteam/agent.cordis.yml': PRESET_BODY(OFFICIAL_ENGINE),
    '.agent-presets/redteam/preset.yml': 'name: 红队模式\n',
  })
  try {
    const first = syncPresetEngines(home)
    assert.equal(first.rewritten.length, 1)
    assert.equal(first.errors.length, 0)
    const file = join(home, '.agent-presets', 'redteam', 'agent.cordis.yml')
    assert.equal(readFileSync(file, 'utf8').includes(PLUGIN_ENGINE), true)
    assert.equal(existsSync(`${file}.bak-engine`), true)
    assert.equal(readFileSync(`${file}.bak-engine`, 'utf8').includes(OFFICIAL_ENGINE), true)

    const second = syncPresetEngines(home)
    assert.equal(second.rewritten.length, 0)
    assert.equal(second.already.length, 1)
    assert.equal(second.errors.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('syncPresetEngines also covers template files under profiles', () => {
  const home = makeHome({
    'profiles/desktop/node_modules/dsh-purge/presets/redteam/agent.cordis.yml': PRESET_BODY(OFFICIAL_ENGINE),
    'profiles/desktop/cordis.patch.yml': 'not a preset\n',
  })
  try {
    const report = syncPresetEngines(home)
    assert.equal(report.rewritten.length, 1)
    assert.match(report.rewritten[0], /dsh-purge/)
    assert.equal(collectTargets(home).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('syncPresetEngines skips a preset with no compaction engine row', () => {
  const home = makeHome({
    '.agent-presets/minimal/agent.cordis.yml': '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n',
  })
  try {
    const report = syncPresetEngines(home)
    assert.equal(report.rewritten.length, 0)
    assert.equal(report.skipped.length, 1)
    assert.equal(report.errors.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('syncPresetEngines returns an empty report for a home with no preset roots', () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-autosync-empty-'))
  try {
    const report = syncPresetEngines(home)
    assert.deepEqual(report, { rewritten: [], already: [], skipped: [], errors: [] })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
