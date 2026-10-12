/**
 * Automatic preset-engine coverage: keep every preset that carries a
 * compaction group pointed at THIS plugin, without the user re-running a
 * script each time a preset is created, installed, or restored by an upgrade.
 *
 * Why this exists: a preset's compaction engine is named inside its own static
 * file. Official presets are rewritten by this plugin's bundle patch, but
 * presets the user authors (`$DSH_HOME/.agent-presets/<name>/agent.cordis.yml`)
 * and the template files other plugins ship in their `node_modules` never pass
 * through that patch chain. Left alone they keep the official engine, whose
 * thresholdRatio is 0.8, so the settings card appears to do nothing.
 *
 * Two channels, because neither alone is sufficient:
 *
 *   1. A watcher on the preset roots catches a preset the moment it is created
 *      or installed. Writes settle after a short debounce so a file is never
 *      rewritten while its author is still writing it.
 *   2. A slow periodic sweep catches anything a watcher can miss — a root that
 *      did not exist yet when watching started, or a change made while the
 *      watcher was busy. Watching is best-effort; the sweep is the backstop.
 *
 * Only the engine row's `name` is rewritten. Thresholds stay in
 * `$DSH_HOME/context-compaction.json` as the single source of truth rather than
 * being duplicated into every preset.
 *
 * Every rewrite is preceded by a one-time `.bak-engine` backup and reported
 * through the logger, so a silent edit is never possible.
 *
 * @module @gjs27/dsh-context-compaction/preset-autosync
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** The engine the official presets name; the row this module replaces. */
export const OFFICIAL_ENGINE = '@deepseek-ai/dsh-compaction-basic'

/** This plugin's package name; the value the row is rewritten to. */
export const PLUGIN_ENGINE = '@gjs27/dsh-context-compaction'

/** A file whose compaction group must run this plugin's engine. */
export interface PresetTarget {
  /** Human-readable label for logs. */
  readonly label: string
  /** Absolute path of the preset file. */
  readonly file: string
  /** `active` = a mounted preset; `template` = a source for future presets. */
  readonly kind: 'active' | 'template'
}

/** Result of one sync pass. */
export interface SyncReport {
  /** Files rewritten by this pass. */
  readonly rewritten: string[]
  /** Files that already named this plugin. */
  readonly already: string[]
  /** Files that carry no compaction engine row. */
  readonly skipped: string[]
  /** Per-file failures; a failure never aborts the pass. */
  readonly errors: string[]
}

/** Narrow view of the host logger; absent in a bare test context. */
interface OptionalLogger {
  readonly logger?: {
    info?(...args: unknown[]): void
    warn?(...args: unknown[]): void
  }
}

/** Narrow view of the Cordis context surface this module needs. */
export interface AutosyncContext {
  readonly logger?: OptionalLogger['logger']
  effect?(callback: () => (() => void) | void, label?: string): void
}

/**
 * Resolve `$DSH_HOME`, falling back to `~/.dsh`, matching every other script
 * and module in this plugin.
 * @returns absolute home directory.
 */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  const chosen = configured !== void 0 && configured.trim().length > 0 ? configured : join(homedir(), '.dsh')
  return resolve(chosen)
}

/**
 * Roots whose preset files this module keeps in sync, in priority order.
 *
 * `watch` decides how the root is monitored. The user's preset directory is
 * small and is where presets actually appear, so it gets a recursive watcher
 * for immediate coverage. The profiles tree contains every profile's
 * `node_modules` — tens of thousands of files — and its preset templates change
 * only when a plugin is installed or upgraded, so watching it recursively would
 * cost far more than it buys; the sweep covers it instead.
 *
 * @param home - resolved `$DSH_HOME`.
 * @returns directory paths; a missing one is simply skipped.
 */
export function presetRoots(home: string): { dir: string; kind: PresetTarget['kind']; depth: number; watch: 'recursive' | 'sweep' }[] {
  return [
    { dir: join(home, '.agent-presets'), kind: 'active', depth: 2, watch: 'recursive' },
    { dir: join(home, 'profiles'), kind: 'template', depth: 5, watch: 'sweep' },
  ]
}

/** Whether a path looks like a preset definition or a preset-generating patch. */
export function isPresetPath(file: string): boolean {
  const normalized = file.split(sep).join('/')
  // The user's own presets: $DSH_HOME/.agent-presets/<name>/agent.cordis.yml
  if (/\.agent-presets\/[^/]+\/agent\.cordis\.ya?ml$/.test(normalized)) return true
  // Plugin-shipped seeds and templates.
  if (/\/preset\/agent\.cordis\.ya?ml$/.test(normalized)) return true
  if (/\/presets\/[^/]+\/agent\.cordis\.ya?ml$/.test(normalized)) return true
  if (/\/preset\.generated\.patch\.ya?ml$/.test(normalized)) return true
  return false
}

/**
 * Rewrite the compaction engine row's `name` inside one preset text.
 *
 * Only the `name` immediately following a `- id: compaction-basic` row is
 * touched, so comments that merely mention the package are left alone.
 *
 * @param text - full preset file contents.
 * @returns the new text plus whether anything changed.
 */
export function rewriteEngineName(text: string): { text: string; changed: boolean } {
  const lines = text.split(/\r?\n/)
  let changed = false
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s+id:\s*compaction-basic\s*$/.test(lines[i])) continue
    const next = i + 1
    if (next >= lines.length) continue
    const match = /^(\s*)name:\s*'([^']+)'\s*$/.exec(lines[next])
    if (match === null) continue
    if (match[2] === PLUGIN_ENGINE) continue
    if (match[2] !== OFFICIAL_ENGINE) continue
    lines[next] = `${match[1]}name: '${PLUGIN_ENGINE}'`
    changed = true
  }
  return { text: lines.join('\n'), changed }
}

/**
 * Collect every preset file under the configured roots.
 * @param home - resolved `$DSH_HOME`.
 * @returns targets, deduplicated by absolute path.
 */
export function collectTargets(home: string): PresetTarget[] {
  const seen = new Set<string>()
  const out: PresetTarget[] = []
  for (const root of presetRoots(home)) {
    if (!existsSync(root.dir)) continue
    // `insideModules` distinguishes the profile's own node_modules (which holds
    // the plugins whose preset templates must be synced) from a package's
    // nested dependency tree (third-party copies, not this profile's presets).
    const walk = (dir: string, depth: number, insideModules: boolean): void => {
      if (depth > root.depth) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') {
            if (insideModules) continue
            walk(path, depth + 1, true)
            continue
          }
          walk(path, depth + 1, insideModules)
          continue
        }
        if (!/\.ya?ml$/.test(entry.name)) continue
        if (!isPresetPath(path)) continue
        if (seen.has(path)) continue
        seen.add(path)
        out.push({
          label: path.replace(home, '…DSH_HOME'),
          file: path,
          kind: root.kind,
        })
      }
    }
    walk(root.dir, 0, false)
  }
  return out
}

/**
 * Rewrite every preset whose compaction engine is still the official one.
 *
 * Reads first and writes only when the engine row actually needs changing, so a
 * pass over an already-synced tree performs no writes at all.
 *
 * @param home - resolved `$DSH_HOME`.
 * @param logger - optional host logger for the change record.
 * @returns what this pass did.
 */
export function syncPresetEngines(home: string, logger?: OptionalLogger['logger']): SyncReport {
  const rewritten: string[] = []
  const already: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  for (const target of collectTargets(home)) {
    try {
      const original = readFileSync(target.file, 'utf8')
      if (!original.includes(OFFICIAL_ENGINE)) {
        if (original.includes(PLUGIN_ENGINE)) already.push(target.label)
        else skipped.push(target.label)
        continue
      }
      const { text, changed } = rewriteEngineName(original)
      if (!changed) {
        already.push(target.label)
        continue
      }
      const backup = `${target.file}.bak-engine`
      if (!existsSync(backup)) copyFileSync(target.file, backup)
      writeFileSync(target.file, text, 'utf8')
      rewritten.push(target.label)
      logger?.info?.('context-compaction: preset engine switched to this plugin: %s', target.label)
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      errors.push(`${target.label}: ${message}`)
      logger?.warn?.('context-compaction: preset autosync failed for %s: %s', target.label, message)
    }
  }

  return { rewritten, already, skipped, errors }
}

/** Debounce window: a file is rewritten only after its writes settle. */
const DEBOUNCE_MS = 1500

/** Backstop sweep interval; also re-arms watchers for roots that appeared later. */
const SWEEP_MS = 15_000

/**
 * The live autosync disposer, or undefined when none is installed.
 *
 * This engine is instantiated once per mounted preset plus once for the
 * root-level row, and every instance reaches this module. One process needs one
 * watcher set, not N competing ones, so the first caller owns it and the rest
 * are no-ops until it is disposed.
 */
let liveAutosync: (() => void) | undefined

/**
 * Nearest ancestor of `dir` that exists on disk.
 *
 * A preset root is often absent at start-up — the user has not created
 * `$DSH_HOME/.agent-presets` yet, or a profile's `node_modules` is being
 * installed. Watching the nearest existing ancestor is what lets the plugin
 * notice the root itself being created.
 *
 * @param dir - directory that may not exist.
 * @returns the first existing directory at or above `dir`, or undefined at the filesystem root.
 */
function nearestExistingAncestor(dir: string): string | undefined {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(current)) return current
    const parent = resolve(current, '..')
    if (parent === current) return void 0
    current = parent
  }
}

/**
 * Start automatic coverage and keep it running for the lifetime of `ctx`.
 *
 * Registers through `ctx.effect` when available so Cordis disposes the watchers
 * with the plugin; otherwise the timers are returned for the caller to clear.
 *
 * @param ctx - host context used for logging and disposal.
 * @returns a disposer that stops every watcher and timer.
 */
export function installPresetAutosync(ctx: AutosyncContext): () => void {
  if (liveAutosync !== undefined) return liveAutosync

  const home = resolveDshHome()
  const logger = ctx.logger
  const disposers: (() => void)[] = []
  let disposed = false
  let debounce: ReturnType<typeof setTimeout> | undefined

  const runSync = (): void => {
    if (disposed) return
    try {
      const report = syncPresetEngines(home, logger)
      if (report.errors.length > 0) {
        logger?.warn?.('context-compaction: preset autosync finished with %d error(s)', report.errors.length)
      }
    } catch (error) {
      // Coverage is a convenience; a failure must never disturb compaction.
      logger?.warn?.('context-compaction: preset autosync pass failed: %s', String((error as Error)?.message ?? error))
    }
  }

  const schedule = (): void => {
    if (disposed) return
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      runSync()
    }, DEBOUNCE_MS)
    // Do not keep the process alive purely for a debounce.
    ;(debounce as unknown as { unref?: () => void })?.unref?.()
  }

  // Channel 1 — watch each root. A root that does not exist yet is watched
  // through its nearest existing ancestor, so its creation is noticed too; each
  // sweep re-arms anything that has since appeared.
  const watched = new Set<string>()

  const attachWatchers = (): void => {
    if (disposed) return
    for (const root of presetRoots(home)) {
      if (root.watch === 'sweep') continue
      const target = existsSync(root.dir) ? root.dir : nearestExistingAncestor(root.dir)
      if (target === void 0) continue
      const recursive = target === root.dir
      const key = `${target}\u0000${recursive}`
      if (watched.has(key)) continue
      // When watching an ancestor, the interesting events are the root being
      // created plus any preset-looking path below it. The root's own name is
      // therefore part of the filter, not something to discard.
      const rootSegment = root.dir.slice(target.length).replace(/^[\\/]+/, '').split(/[\\/]/)[0]
      try {
        const watcher = watch(target, { recursive }, (_event, filename) => {
          if (!recursive && filename !== null) {
            const name = String(filename)
            if (!isPresetPath(name) && name.split(/[\\/]/)[0] !== rootSegment) return
          }
          schedule()
          // A root may have just been created; pick it up on the next sweep.
          if (!existsSync(root.dir)) return
          if (!watched.has(`${root.dir}\u0000true`)) attachWatchers()
        })
        watcher.on('error', (error) => {
          watched.delete(key)
          logger?.warn?.('context-compaction: preset watcher stopped for %s: %s', target, String(error?.message ?? error))
        })
        watched.add(key)
        disposers.push(() => {
          watched.delete(key)
          watcher.close()
        })
      } catch (error) {
        // Recursive watching is platform-dependent; the sweep still covers it.
        logger?.warn?.('context-compaction: cannot watch %s: %s', target, String((error as Error)?.message ?? error))
      }
    }
  }

  // Channel 2 — the backstop sweep, which also re-arms watchers.
  const sweep = setInterval(() => {
    attachWatchers()
    runSync()
  }, SWEEP_MS)
  ;(sweep as unknown as { unref?: () => void })?.unref?.()
  disposers.push(() => clearInterval(sweep))

  attachWatchers()
  // One immediate pass: a preset created before this plugin loaded is caught now.
  runSync()

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (liveAutosync === dispose) liveAutosync = undefined
    if (debounce !== undefined) clearTimeout(debounce)
    for (const stop of disposers) {
      try {
        stop()
      } catch {
        /* a watcher that already closed must not block disposal */
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'context-compaction: preset autosync')
    } catch (error) {
      logger?.warn?.('context-compaction: preset autosync effect not registered: %s', String((error as Error)?.message ?? error))
    }
  }

  liveAutosync = dispose
  return dispose
}

/**
 * Stop the live autosync, if any.
 *
 * `fs.watch` handles keep the Node event loop alive and cannot be unref'd, so
 * any embedding that must exit — a test runner above all — has to dispose the
 * watchers explicitly. The Host never calls this; Cordis disposes through the
 * registered `ctx.effect`.
 *
 * @returns whether an autosync was running.
 */
export function disposePresetAutosync(): boolean {
  if (liveAutosync === undefined) return false
  liveAutosync()
  return true
}
