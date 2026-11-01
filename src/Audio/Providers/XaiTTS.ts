import { existsSync as exists } from 'node:fs'
import type { ILogObj, Logger } from 'tslog'
import type { XaiTTSConfig } from '../../Utils/Config'
import { XAI_TOKEN_FILE, xaiAccessToken } from '../../Utils/XaiOAuth'
import { fetchWithRetry } from '../FetchWithRetry'
import type { SynthesisSignal, TTSProvider } from '../TTSProvider'

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
    const { apiKey } = this.config()
    return apiKey || exists(XAI_TOKEN_FILE) ? undefined : 'xaiTTS.apiKey is not set in config.json and there is no xAI login (run `pnpm xai:login`)'
  }

  public async synthesize(text: string, lang: string, voice: string, signal: SynthesisSignal): Promise<Uint8Array | null> {
    const { apiKey } = this.config()
    let token = apiKey
    try {
      token ||= await xaiAccessToken()
      const res = await fetchWithRetry('https://api.x.ai/v1/tts', {
        method: 'POST',
        // biome-ignore lint/style/useNamingConvention: HTTP header
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          language: lang,
          // biome-ignore lint/style/useNamingConvention: xAI API field
          ...(voice ? { voice_id: voice } : {}),
          // biome-ignore lint/style/useNamingConvention: xAI API field
          output_format: { codec: 'pcm', sample_rate: 48000 }
        }),
        signal
      })
      if (!res.ok) {
        const detail = (await res.text()).replaceAll(token, '<redacted>').replace(/\s+/g, ' ').trim().slice(0, 300)
        const hint = res.status === 403 && !apiKey ? '; the xAI login may not be allowed to use the API, set xaiTTS.apiKey instead' : ''
        this.logger.error(`xAI TTS API responded ${res.status}: ${detail || 'no error details'}${hint}`)
        return null
      }
      const type = res.headers.get('content-type') ?? ''
      const body = await res.arrayBuffer()
      // A 200 can still be an error body; xAI's actual content-type for pcm is unconfirmed, so only an
      // error-shaped type (json/text/html/xml) is rejected, not an audio type we did not anticipate
      if (/json|text|html|xml/i.test(type) || body.byteLength % 2 !== 0) {
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
