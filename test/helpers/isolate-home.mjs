/**
 * Test isolation for the settings file and the preset autosync.
 *
 * The engine reads `$DSH_HOME/context-compaction.json` at construction so the
 * settings card can act as the single source of truth for thresholds, and it
 * starts the preset autosync, which installs `fs.watch` handles. Both leak into
 * tests otherwise: a developer machine's real file overrides the official
 * defaults that tests assert, and the watch handles keep the test process alive
 * so the runner never exits.
 *
 * Call `isolateDshHome()` once at the top of a test file that constructs the
 * engine: it points `$DSH_HOME` at an empty temporary directory for the whole
 * file, disposes the autosync afterwards, and restores the previous value.
 * Each test file runs in its own process under `node --test`, so this is safe.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { disposePresetAutosync } from '../../lib/preset-autosync.js'

/** Point `$DSH_HOME` at an empty temp dir for this test file. */
export function isolateDshHome() {
  const previous = process.env.DSH_HOME
  let dir
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-isolated-home-'))
    process.env.DSH_HOME = dir
  })
  after(() => {
    // Watch handles keep the event loop alive; release them before the process
    // is expected to exit.
    disposePresetAutosync()
    if (previous === void 0) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (dir !== void 0) rmSync(dir, { recursive: true, force: true })
  })
}
