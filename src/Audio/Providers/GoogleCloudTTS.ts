import type { ILogObj, Logger } from 'tslog'
import { fetchWithRetry } from '../FetchWithRetry'
import type { SynthesisSignal, TTSProvider } from '../TTSProvider'

// Google Cloud Text-to-Speech (WaveNet voices), OGG Opus
export class GoogleCloudTTS implements TTSProvider {
  public readonly id = 'google-cloud'
  public readonly format = 'ogg'
  public readonly usesVoice = true
  private logger: Logger<ILogObj>
  private apiKey: () => string

  constructor(apiKey: () => string, logger: Logger<ILogObj>) {
    this.apiKey = apiKey
    this.logger = logger.getSubLogger({ name: 'GoogleCloudTTS' })
  }

  public unavailableReason() {
    return this.apiKey() ? undefined : 'googleTTS.apiKey is not set in config.json'
  }

  public async synthesize(text: string, lang: string, voice: string, signal: SynthesisSignal): Promise<Uint8Array | null> {
    const url = 'https://content-texttospeech.googleapis.com/v1/text:synthesize?alt=json'
    const options = {
      body: JSON.stringify({
        input: { text },
        voice: { name: voice, languageCode: lang },
        audioConfig: { audioEncoding: 'OGG_OPUS' }
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey(),
        'X-Origin': 'https://explorer.apis.google.com',
        'X-Referer': 'https://explorer.apis.google.com'
      },
      method: 'POST',
      signal
    }
    try {
      const res = await fetchWithRetry(url, options)
      const data = await res.json().catch(() => undefined)
      if (!res.ok) {
        const detail = data?.error ? `${data.error.message} (Code: ${data.error.code})` : 'no error details'
        throw new Error(`Google TTS API responded ${res.status}: ${detail}`)
      }
      if (typeof data?.audioContent !== 'string' || data.audioContent === '') {
        throw new Error('Unable to get audio content from response')
      }
      return Buffer.from(data.audioContent, 'base64')
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Download TTS failed: ${error.message}`, error)
      }
      return null
    }
  }
}
