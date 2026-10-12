/**
 * Test isolation for the settings file.
 *
 * The engine reads `$DSH_HOME/context-compaction.json` at construction so the
 * settings card can act as the single source of truth for thresholds. That
 * makes a developer machine's real file — which usually has a lowered ratio —
 * leak into tests that assert the OFFICIAL defaults.
 *
 * Call `isolateDshHome()` once at the top of such a test file: it points
 * `$DSH_HOME` at an empty temporary directory for the whole file and restores
 * the previous value afterwards. Each test file runs in its own process under
 * `node --test`, so this is safe.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'

/** Point `$DSH_HOME` at an empty temp dir for this test file. */
export function isolateDshHome() {
  const previous = process.env.DSH_HOME
  let dir
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-isolated-home-'))
    process.env.DSH_HOME = dir
  })
  after(() => {
    if (previous === void 0) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (dir !== void 0) rmSync(dir, { recursive: true, force: true })
  })
}
