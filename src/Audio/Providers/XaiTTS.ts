import type { ILogObj, Logger } from 'tslog'
import type { XaiTTSConfig } from '../../Utils/Config'
import type { TTSProvider } from '../TTSProvider'

// https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#supported-languages
const LANGUAGES = new Set(['en', 'ar-eg', 'ar-sa', 'ar-ae', 'bn', 'zh', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt-br', 'pt-pt', 'ru', 'es-mx', 'es-es', 'tr', 'vi'])

// xAI text to speech as 48kHz pcm. xAI's pcm is mono s16le (there is no channel option), so each
// sample is played on both channels
export class XaiTTS implements TTSProvider {
  public readonly id = 'xai'
  public readonly format = 'pcm'
  public readonly usesVoice = true
  private logger: Logger<ILogObj>
  private config: () => XaiTTSConfig

  constructor(config: () => XaiTTSConfig, logger: Logger<ILogObj>) {
    this.config = config
    this.logger = logger.getSubLogger({ name: 'XaiTTS' })
  }

  public unavailableReason() {
    return this.config().apiKey ? undefined : 'xaiTTS.apiKey is not set in config.json'
  }

  public cacheKey(text: string, lang: string, voice: string) {
    return `${text}-${this.language(lang)}-${this.voice(voice)}-pcm48000`
  }

  private language(lang: string) {
    const primary = lang.split(/[-_]/)[0].toLowerCase()
    return this.config().language || (LANGUAGES.has(primary) ? primary : 'auto')
  }

  private voice(voice: string) {
    return voice || this.config().voice || 'eve'
  }

  public async synthesize(text: string, lang: string, voice = ''): Promise<Uint8Array | null> {
    const { apiKey } = this.config()
    try {
      const res = await fetch('https://api.x.ai/v1/tts', {
        method: 'POST',
        // biome-ignore lint/style/useNamingConvention: HTTP header
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          // biome-ignore lint/style/useNamingConvention: xAI API field
          voice_id: this.voice(voice),
          language: this.language(lang),
          // biome-ignore lint/style/useNamingConvention: xAI API field
          output_format: { codec: 'pcm', sample_rate: 48000 }
        })
      })
      if (!res.ok) {
        const detail = (await res.text()).replaceAll(apiKey, '<redacted>').replace(/\s+/g, ' ').trim().slice(0, 300)
        this.logger.error(`xAI TTS API responded ${res.status}: ${detail || 'no error details'}`)
        return null
      }
      const type = res.headers.get('content-type') ?? ''
      const body = await res.arrayBuffer()
      // A 200 can still be an error body; xAI's actual content-type for pcm is unconfirmed, so only an
      // error-shaped type (json/text/html/xml) is rejected, not an audio type we did not anticipate
      if (/json|text|html|xml/i.test(type) || body.byteLength === 0 || body.byteLength % 2 !== 0) {
        this.logger.error(`xAI TTS returned no usable pcm (${type || 'no content type'}, ${body.byteLength} bytes)`)
        return null
      }
      const mono = new Uint16Array(body)
      const stereo = new Uint16Array(mono.length * 2)
      mono.forEach((sample, i) => {
        stereo[i * 2] = stereo[i * 2 + 1] = sample
      })
      return new Uint8Array(stereo.buffer)
    } catch (error) {
      this.logger.error(`xAI TTS request failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }
}
