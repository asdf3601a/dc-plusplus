import { existsSync as exists, readdirSync as readDir } from 'node:fs'
import { extname } from 'node:path'

export const ASSETS_DIR = 'assets'

// An assets/<id>.json already checked to be a JSON object
type Asset = Record<string, unknown>

// Frozen formats of assets/<id>.json per data version; never change one, add a new version instead.
// Files are only checked to be JSON objects, so any other key is carried along as it is.

// Per-event texts; a missing one plays assets/<id>_<event>.wav instead
interface AssetTexts {
  join?: string
  left?: string
  // biome-ignore lint/style/useNamingConvention: From json file
  switched_out?: string
  // biome-ignore lint/style/useNamingConvention: From json file
  switched_in?: string
}

// Data version 1: use_wave_tts true with a voice -> Google Cloud, anything else -> Google Translate
type AssetV1 = AssetTexts & {
  // biome-ignore lint/style/useNamingConvention: From json file
  use_wave_tts?: boolean
  lang?: string
  voice?: string
  [key: string]: unknown
}

// Data version 2: a TTS provider id ('google-translate', 'google-cloud', ...)
type AssetV2 = AssetTexts & {
  provider: string
  lang?: string
  voice?: string
  [key: string]: unknown
}

const LEGACY_KEY = 'use_wave_tts'

// 1 -> 2: replace use_wave_tts with a provider id; a provider that is already set is kept. Returns
// undefined when the file needs no change.
function v1ToV2(config: AssetV1): AssetV2 | undefined {
  const provider = config.provider
  const hasProvider = typeof provider === 'string'
  if (hasProvider && !(LEGACY_KEY in config)) return undefined
  // use_wave_tts without a voice fell back to Google Translate at runtime; match that, not the flag alone
  const usedWaveTTS = Boolean(config[LEGACY_KEY]) && Boolean(config.voice)
  const migrated: AssetV2 = {
    provider: hasProvider ? provider : usedWaveTTS ? 'google-cloud' : 'google-translate'
  }
  for (const [key, value] of Object.entries(config)) {
    if (key !== LEGACY_KEY && key !== 'provider') migrated[key] = value
  }
  return migrated
}

// ASSET_STEPS[n] converts one assets/<id>.json from data version n to n + 1. Returns undefined when
// the file needs no change, so running a step again on converted data changes nothing. Steps run in
// order, so the file a step gets is at its version.
export const ASSET_STEPS: Record<number, (config: Asset) => Asset | undefined> = {
  1: (config) => v1ToV2(config as AssetV1)
}

// Names of the assets/<id>.json files; .wav files are never read or touched
export function assetConfigFiles(): string[] {
  if (!exists(ASSETS_DIR)) return []
  return readDir(ASSETS_DIR)
    .filter((file) => extname(file) === '.json')
    .sort()
}
