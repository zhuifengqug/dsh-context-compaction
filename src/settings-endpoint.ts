/**
 * Host half of the threshold settings card.
 *
 * Serves the card over the Connection Fetch registry (`/api/context-compaction`),
 * which puts the endpoint inside the same Host/Origin fence and browser
 * authentication gate every other Host API method passes through. Persists the
 * chosen thresholds to `$DSH_HOME/context-compaction.json`.
 *
 * Why not the official config editor: `dsh-config-editor`'s `entries()` filters
 * to entries whose parent fiber entry id is `include`, and an engine row inside
 * a `preset-*` group has a preset parent, so it is never addressable there.
 * This endpoint owns its own storage instead.
 *
 * @module @gjs27/dsh-context-compaction/settings-endpoint
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  fromDocument,
  toDocument,
  resolvePolicy,
  THRESHOLD_FIELDS,
  RECOMMENDED_PRESETS,
  OFFICIAL_DEFAULTS,
  ThresholdSettingsError,
  type ThresholdSettings,
} from './threshold-settings.ts'

/** Route the card reads and writes. */
export const ROUTE_PATH = '/api/context-compaction'

const MAX_BODY_BYTES = 64 * 1024
const HOME_ENV = 'DSH_HOME'
const HOME_DIR_NAME = '.dsh'
const FILE_NAME = 'context-compaction.json'

/** Expand `~` / `~/x` against the OS home. */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home the way the built-in loaders do: a non-blank
 * `$DSH_HOME` wins, otherwise `~/.dsh`.
 * @returns the absolute harness home.
 */
export function resolveHome(): string {
  const configured = process.env[HOME_ENV]
  const chosen = configured !== void 0 && configured.trim().length > 0
    ? configured
    : join(homedir(), HOME_DIR_NAME)
  return resolve(expandHomePath(chosen))
}

/** Absolute path of the settings file. */
export function settingsFilePath(home: string = resolveHome()): string {
  return join(home, FILE_NAME)
}

/** JSON response with the no-store header the settings panel expects. */
function jsonResponse(status: number, payload: unknown): Response {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

/** Message of a thrown value. */
function messageOf(error: unknown): string {
  return String((error as { message?: unknown } | undefined)?.message ?? error)
}

/**
 * Read stored settings from disk.
 * @param file - absolute settings file path.
 * @returns stored settings, or `undefined` when absent/unusable.
 */
export async function readStoredSettings(file: string): Promise<ThresholdSettings | undefined> {
  try {
    const text = await readFile(file, 'utf8')
    return fromDocument(JSON.parse(text))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return void 0
    return void 0
  }
}

/**
 * Synchronous read of stored settings.
 *
 * A Cordis plugin constructor cannot await, yet the engine needs the saved
 * thresholds at construction time. This reads the same file the card writes, so
 * the file — not the profile patch — is the single source of truth for the
 * tunable policy; the patch's `config` block only seeds the defaults.
 *
 * @param file - absolute settings file path.
 * @returns stored settings, or `undefined` when absent/unusable.
 */
export function readStoredSettingsSync(file: string = settingsFilePath()): ThresholdSettings | undefined {
  try {
    return fromDocument(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return void 0
  }
}

/**
 * Persist validated settings.
 * @param file - absolute settings file path.
 * @param settings - validated settings to store.
 */
export async function writeStoredSettings(file: string, settings: ThresholdSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(toDocument(settings), null, 2)}\n`, 'utf8')
}

/** Field metadata the card renders, so the UI and the validator cannot drift. */
function fieldMetadata() {
  return THRESHOLD_FIELDS.map((field) => ({
    key: field.key,
    min: field.min,
    max: field.max,
    fractional: field.fractional,
    officialDefault: field.officialDefault,
  }))
}

/**
 * Build the card's current state.
 * @param file - absolute settings file path.
 * @returns values, effective policy, source, and field metadata.
 */
export async function readState(file: string) {
  const stored = await readStoredSettings(file)
  const { policy, source } = resolvePolicy(stored)
  return {
    exists: stored !== void 0,
    stored: stored ?? null,
    policy,
    source,
    officialDefaults: OFFICIAL_DEFAULTS,
    presets: RECOMMENDED_PRESETS,
    fields: fieldMetadata(),
    path: file,
    note: 'Saved values override the official engine defaults (thresholdRatio 0.8 / headroomTokens 65536 / retainRatio 0.16). They take effect for sessions started after the engine entry reloads.',
  }
}

/** Parse a JSON request body under a byte cap. */
async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ThresholdSettingsError('BODY_TOO_LARGE', 'request body too large')
  }
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new ThresholdSettingsError('BODY_TOO_LARGE', 'request body too large')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ThresholdSettingsError('BAD_JSON', 'request body must be JSON')
  }
}

/**
 * Serve one card request.
 * @param request - fenced Fetch request (Connection already fenced and authenticated).
 * @param file - absolute settings file path.
 * @returns the response.
 */
export async function handle(request: Request, file: string): Promise<Response> {
  if (request.method === 'GET') {
    try {
      return jsonResponse(200, await readState(file))
    } catch (error) {
      return jsonResponse(500, { error: messageOf(error) })
    }
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' })
  }
  try {
    const body = await readJsonBody(request)
    const record = body as { settings?: unknown } | null
    const candidate = record !== null && typeof record === 'object' && 'settings' in record
      ? record.settings
      : body
    const { validateSettings } = await import('./threshold-settings.ts')
    const settings = validateSettings(candidate)
    await writeStoredSettings(file, settings)
    return jsonResponse(200, { ok: true, ...(await readState(file)) })
  } catch (error) {
    if (error instanceof ThresholdSettingsError) {
      return jsonResponse(400, { error: error.message, code: error.code })
    }
    return jsonResponse(500, { error: messageOf(error) })
  }
}

/** Minimal shape of the host context this module needs. */
interface SettingsHostContext {
  inject(names: string[], callback: (host: { connection: { fetch: { register(route: unknown): unknown } } }) => void): unknown
}

/**
 * Register the card's endpoint once Connection is available.
 * @param ctx - host plugin context.
 */
export function registerSettingsEndpoint(ctx: SettingsHostContext): void {
  const file = settingsFilePath()
  ctx.inject(['connection'], (host) => {
    host.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request: Request) => handle(request, file),
    })
  })
}
