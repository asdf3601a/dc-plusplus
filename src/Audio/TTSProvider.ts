import type { AudioFormat } from './AudioAsset'

// A replaceable speech engine. It only turns text into audio bytes;
// caching, queueing and playback are handled elsewhere.
export interface TTSProvider {
  // Stable id, part of the cache key so providers never share files
  readonly id: string
  readonly format: AudioFormat
  // false: the voice name is ignored, and left out of the cache key
  readonly usesVoice: boolean
  // Why the provider cannot be used right now (e.g. missing API key), or undefined when it can
  unavailableReason(): string | undefined
  // Cache key after the id, when it is not text-lang-voice as given (e.g. the voice and language actually sent)
  cacheKey?(text: string, lang: string, voice: string): string
  // signal aborts at the synthesis time limit, which is deadline (ms since the epoch); pass it to every fetch
  synthesize(text: string, lang: string, voice: string, signal: SynthesisSignal): Promise<Uint8Array | null>
}

export type SynthesisSignal = AbortSignal & { readonly deadline: number }
