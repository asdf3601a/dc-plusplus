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
export type AssetV1 = AssetTexts & {
  // biome-ignore lint/style/useNamingConvention: From json file
  use_wave_tts?: boolean
  lang?: string
  voice?: string
  [key: string]: unknown
}

// Data version 2: a TTS provider id ('google-translate', 'google-cloud', ...)
export type AssetV2 = AssetTexts & {
  provider: string
  lang?: string
  voice?: string
  [key: string]: unknown
}
