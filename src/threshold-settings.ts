/**
 * Threshold settings model for the settings-page card.
 *
 * This module is deliberately IO-free: it validates and normalizes the
 * user-editable threshold fields, and merges them into an effective policy.
 * The HTTP handler and the card both build on it, and the offline tests read
 * the compiled artifact directly.
 *
 * @module @gjs27/dsh-context-compaction/threshold-settings
 */

/** A single editable numeric field of the threshold card. */
export interface ThresholdFieldSpec {
  /** Config key this field maps to. */
  readonly key: 'thresholdRatio' | 'headroomTokens' | 'retainRatio' | 'retainTokens'
  /** Inclusive lower bound. */
  readonly min: number
  /** Inclusive upper bound. */
  readonly max: number
  /** Whether fractional values are allowed. */
  readonly fractional: boolean
  /** Official default when the user supplies nothing. */
  readonly officialDefault: number
}

/** Editable fields, in card order. */
export const THRESHOLD_FIELDS: readonly ThresholdFieldSpec[] = [
  { key: 'thresholdRatio', min: 0.05, max: 0.95, fractional: true, officialDefault: 0.8 },
  { key: 'headroomTokens', min: 0, max: 1_000_000, fractional: false, officialDefault: 65536 },
  { key: 'retainRatio', min: 0.01, max: 0.9, fractional: true, officialDefault: 0.16 },
  { key: 'retainTokens', min: 0, max: 1_000_000, fractional: false, officialDefault: 0 },
]

/** Wire shape of the persisted settings document. */
export interface ThresholdSettings {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly retainRatio: number
  readonly retainTokens: number
}

/** Current on-disk schema version. */
export const SETTINGS_SCHEMA_VERSION = 1

/** Persisted envelope, so future migrations can key off `version`. */
export interface ThresholdSettingsDocument {
  readonly version: number
  readonly settings: ThresholdSettings
}

/** Effective policy handed to the engine. */
export interface ResolvedThresholdPolicy {
  /** Fraction of the routed model window that arms compaction. */
  readonly thresholdRatio: number
  /** Tokens held back from the window on top of the ratio budget. */
  readonly headroomTokens: number
  /** Verbatim-tail policy; `retainTokens` wins when above zero. */
  readonly retainRatio: number
  /** Verbatim-tail token count; `0` means "inherit `retainRatio`". */
  readonly retainTokens: number
}

/** Best-practice starting point shown by the card's preset buttons. */
export const RECOMMENDED_PRESETS: Readonly<Record<string, ThresholdSettings>> = {
  aggressive: { thresholdRatio: 0.5, headroomTokens: 32768, retainRatio: 0.16, retainTokens: 0 },
  balanced: { thresholdRatio: 0.65, headroomTokens: 49152, retainRatio: 0.16, retainTokens: 0 },
  conservative: { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16, retainTokens: 0 },
}

/** Settings equal to the official engine defaults. */
export const OFFICIAL_DEFAULTS: ThresholdSettings = {
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  retainRatio: 0.16,
  retainTokens: 0,
}

/** Raised for a value the card or API must reject. */
export class ThresholdSettingsError extends Error {
  /** Stable machine-readable reason. */
  readonly code: string

  /**
   * @param code - stable reason code.
   * @param message - human-readable explanation.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ThresholdSettingsError'
    this.code = code
  }
}

/**
 * Validate one numeric field value.
 * @param spec - the field's constraints.
 * @param value - candidate value.
 * @returns the accepted number.
 */
export function validateField(spec: ThresholdFieldSpec, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ThresholdSettingsError('NOT_A_NUMBER', `${spec.key} must be a finite number`)
  }
  if (!spec.fractional && !Number.isInteger(value)) {
    throw new ThresholdSettingsError('NOT_AN_INTEGER', `${spec.key} must be an integer`)
  }
  if (value < spec.min || value > spec.max) {
    throw new ThresholdSettingsError('OUT_OF_RANGE', `${spec.key} must be between ${spec.min} and ${spec.max}`)
  }
  return value
}

/**
 * Validate a whole settings object, rejecting unknown and missing keys.
 * @param input - untrusted candidate.
 * @returns a detached validated copy.
 */
export function validateSettings(input: unknown): ThresholdSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ThresholdSettingsError('NOT_AN_OBJECT', 'settings must be a plain object')
  }
  const record = input as Record<string, unknown>
  const known = new Set(THRESHOLD_FIELDS.map((field) => field.key))
  for (const key of Object.keys(record)) {
    if (!known.has(key as ThresholdFieldSpec['key'])) {
      throw new ThresholdSettingsError('UNKNOWN_FIELD', `unknown settings field: ${key}`)
    }
  }
  const out: Record<string, number> = {}
  for (const spec of THRESHOLD_FIELDS) {
    if (!(spec.key in record)) {
      throw new ThresholdSettingsError('MISSING_FIELD', `missing settings field: ${spec.key}`)
    }
    out[spec.key] = validateField(spec, record[spec.key])
  }
  return out as unknown as ThresholdSettings
}

/**
 * Serialize settings into the versioned on-disk envelope.
 * @param settings - validated settings.
 * @returns the document to persist.
 */
export function toDocument(settings: ThresholdSettings): ThresholdSettingsDocument {
  return { version: SETTINGS_SCHEMA_VERSION, settings: validateSettings(settings) }
}

/**
 * Parse a persisted document, tolerating absent or older shapes.
 * @param raw - parsed JSON value from disk, or `undefined` when the file is absent.
 * @returns validated settings, or `undefined` when nothing usable is stored.
 */
export function fromDocument(raw: unknown): ThresholdSettings | undefined {
  if (raw === null || typeof raw !== 'object') return void 0
  const record = raw as Record<string, unknown>
  const candidate = 'settings' in record ? record.settings : record
  try {
    return validateSettings(candidate)
  } catch {
    return void 0
  }
}

/**
 * Merge stored settings over the official defaults to get the effective policy.
 * @param stored - settings read from disk, if any.
 * @returns the effective policy; an empty object yields official defaults.
 */
export function resolvePolicy(stored?: ThresholdSettings): {
  readonly policy: ResolvedThresholdPolicy
  readonly source: 'stored' | 'official-defaults'
} {
  const settings = stored ?? OFFICIAL_DEFAULTS
  return {
    source: stored === void 0 ? 'official-defaults' : 'stored',
    policy: {
      thresholdRatio: settings.thresholdRatio,
      headroomTokens: settings.headroomTokens,
      retainRatio: settings.retainRatio,
      retainTokens: settings.retainTokens,
    },
  }
}

/**
 * Render the effective policy as the `config` block of a preset engine row.
 * `retainTokens: 0` is omitted so the official `retainRatio` keeps effect.
 * @param policy - effective policy.
 * @returns a plain object suitable for YAML serialization.
 */
export function toEngineConfig(policy: ResolvedThresholdPolicy): Record<string, number> {
  const config: Record<string, number> = {
    thresholdRatio: policy.thresholdRatio,
    headroomTokens: policy.headroomTokens,
    retainRatio: policy.retainRatio,
  }
  if (policy.retainTokens > 0) config.retainTokens = policy.retainTokens
  return config
}
