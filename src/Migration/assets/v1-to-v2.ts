import type { AssetV1, AssetV2 } from './types'

const LEGACY_KEY = 'use_wave_tts'

// 1 -> 2: replace use_wave_tts with a provider id; a provider that is already set is kept. Returns
// undefined when the file needs no change.
export function v1ToV2(config: AssetV1): AssetV2 | undefined {
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
