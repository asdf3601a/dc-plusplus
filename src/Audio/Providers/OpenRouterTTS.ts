import type { ILogObj, Logger } from 'tslog'
import { fetchWithRetry } from '../FetchWithRetry'
import type { TTSProvider } from '../TTSProvider'

// OpenRouter text to speech as 48kHz stereo pcm. The pcm's rate and channels depend on the model,
// so they are read from the Content-Type and converted
export class OpenRouterTTS implements TTSProvider {
  public readonly id = 'openrouter'
  public readonly format = 'pcm'
  public readonly usesVoice = true
  private logger: Logger<ILogObj>
  private apiKey: () => string
  private model: () => string

  constructor(apiKey: () => string, model: () => string, logger: Logger<ILogObj>) {
    this.apiKey = apiKey
    this.model = model
    this.logger = logger.getSubLogger({ name: 'OpenRouterTTS' })
  }

  public unavailableReason() {
    if (!this.apiKey()) return 'openrouterTTS.apiKey is not set in config.json'
    if (!this.model()) return 'openrouterTTS.model is not set in config.json'
    return undefined
  }

  public async synthesize(text: string, _lang: string, voice: string, signal: AbortSignal): Promise<Uint8Array | null> {
    if (!voice) {
      this.logger.error('OpenRouter TTS requires a voice, but none was given')
      return null
    }
    try {
      const res = await fetchWithRetry('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        // biome-ignore lint/style/useNamingConvention: HTTP header
        headers: { Authorization: `Bearer ${this.apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model(),
          input: text,
          voice,
          // biome-ignore lint/style/useNamingConvention: OpenRouter API field
          response_format: 'pcm'
        }),
        signal
      })
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300)
        this.logger.error(`OpenRouter TTS API responded ${res.status}: ${detail || 'no error details'}`)
        return null
      }
      const type = res.headers.get('content-type') ?? ''
      const body = new Uint8Array(await res.arrayBuffer())
      if (body.length === 0 || body.length % 2 !== 0 || looksLikeJson(body)) {
        this.logger.error(`OpenRouter TTS returned no usable pcm (${type || 'no content type'}, ${body.length} bytes)`)
        return null
      }
      const rate = Number(/rate=(\d+)/i.exec(type)?.[1])
      const channels = Number(/channels=(\d+)/i.exec(type)?.[1] ?? '1')
      const mono = new Int16Array(body.buffer, body.byteOffset, body.length / 2)

      if (rate === 48000 && channels === 2) {
        if (body.length % 4 === 0) return body
        this.logger.error(`OpenRouter TTS returned a partial stereo frame (${body.length} bytes)`)
        return null
      }

      if (rate === 48000 && channels === 1) {
        const stereo = new Int16Array(mono.length * 2)
        mono.forEach((sample, i) => {
          stereo[i * 2] = stereo[i * 2 + 1] = sample
        })
        return new Uint8Array(stereo.buffer)
      }

      if (rate === 24000 && channels === 1) {
        const stereo = new Int16Array(mono.length * 4)
        let prev = 0
        mono.forEach((sample, i) => {
          const interpolated = Math.round((prev + sample) / 2)
          prev = sample
          stereo.set([interpolated, interpolated, sample, sample], i * 4)
        })
        return new Uint8Array(stereo.buffer)
      }

      this.logger.error(`OpenRouter TTS returned unsupported pcm format (rate ${rate || 'unknown'}, ${channels} channel(s))`)
      return null
    } catch (error) {
      this.logger.error(`OpenRouter TTS request failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }
}

// A 200 can still be an error body, whatever its Content-Type says
function looksLikeJson(bytes: Uint8Array) {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x7b || byte === 0x5b
  }
  return false
}
