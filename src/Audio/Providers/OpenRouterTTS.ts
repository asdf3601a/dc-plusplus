import type { MPEGDecoderWebWorker } from 'mpg123-decoder'
import type { ILogObj, Logger } from 'tslog'
import { fetchWithRetry } from '../FetchWithRetry'
import type { TTSProvider } from '../TTSProvider'

// OpenRouter text to speech as 48kHz stereo pcm. pcm is requested first; a model that answers it with a 400
// is retried once as mp3 and, when that works, asked for mp3 directly until it rejects mp3 too.
// The audio is decoded by its Content-Type (pcm with rate= and channels=, or mpeg) and resampled to 48kHz stereo
export class OpenRouterTTS implements TTSProvider {
  public readonly id = 'openrouter'
  public readonly format = 'pcm'
  public readonly usesVoice = true
  private logger: Logger<ILogObj>
  private apiKey: () => string
  private model: () => string
  private mp3Models = new Set<string>()
  private mp3Decoder?: MPEGDecoderWebWorker
  // The decoder keeps state between decode() and reset(), so decodes run one at a time
  private decoding: Promise<unknown> = Promise.resolve()

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

  private decode(mp3: Uint8Array) {
    const run = this.decoding.then(async () => {
      this.mp3Decoder ??= new (require('fix-esm').require('mpg123-decoder').MPEGDecoderWebWorker)() as MPEGDecoderWebWorker
      await this.mp3Decoder.ready
      try {
        return await this.mp3Decoder.decode(mp3)
      } finally {
        await this.mp3Decoder.reset()
      }
    })
    this.decoding = run.catch(() => undefined)
    return run
  }

  private request(model: string, text: string, voice: string, format: 'pcm' | 'mp3', signal: AbortSignal) {
    return fetchWithRetry('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      // biome-ignore lint/style/useNamingConvention: HTTP header
      headers: { Authorization: `Bearer ${this.apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        // biome-ignore lint/style/useNamingConvention: OpenRouter API field
        response_format: format
      }),
      signal
    })
  }

  public async synthesize(text: string, _lang: string, voice: string, signal: AbortSignal): Promise<Uint8Array | null> {
    if (!voice) {
      this.logger.error('OpenRouter TTS requires a voice, but none was given')
      return null
    }
    const model = this.model()
    const errorDetail = async (res: Response) => (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300) || 'no error details'
    try {
      const remembered = this.mp3Models.has(model)
      let res = await this.request(model, text, voice, remembered ? 'mp3' : 'pcm', signal)
      const fellBack = !remembered && res.status === 400
      if (fellBack) {
        const pcmError = `400: ${await errorDetail(res)}`
        this.logger.warn(`OpenRouter TTS rejected pcm for model ${model} (${pcmError}), retrying as mp3`)
        res = await this.request(model, text, voice, 'mp3', signal)
        if (!res.ok) {
          await res.body?.cancel()
          this.logger.error(`OpenRouter TTS API responded ${pcmError} (mp3 retry responded ${res.status})`)
          return null
        }
      }
      if (!res.ok) {
        if (res.status === 400) this.mp3Models.delete(model)
        this.logger.error(`OpenRouter TTS API responded ${res.status}: ${await errorDetail(res)}`)
        return null
      }
      const audio = await this.toPCM(res)
      if (fellBack && audio) this.mp3Models.add(model)
      return audio
    } catch (error) {
      this.logger.error(`OpenRouter TTS request failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  private async toPCM(res: Response) {
    const type = res.headers.get('content-type') ?? ''
    const body = new Uint8Array(await res.arrayBuffer())
    if (body.length === 0 || /^application\/json\s*(;|$)/i.test(type)) {
      this.logger.error(`OpenRouter TTS returned no usable audio (${type || 'no content type'}, ${body.length} bytes)`)
      return null
    }

    if (/^audio\/pcm\s*(;|$)/i.test(type)) {
      const rate = Number(/rate=(\d+)/i.exec(type)?.[1])
      const channels = Number(/channels=(\d+)/i.exec(type)?.[1] ?? '1')
      if (!rate || !channels) {
        this.logger.error(`OpenRouter TTS returned pcm without a valid rate or channels (${type}, ${body.length} bytes)`)
        return null
      }
      if (body.length % (2 * channels) !== 0) {
        this.logger.error(`OpenRouter TTS returned a partial pcm frame (${type}, ${body.length} bytes)`)
        return null
      }
      return toStereo48k(new Int16Array(body.buffer, body.byteOffset, body.length / 2), rate, channels)
    }

    if (/^audio\/mpeg\s*(;|$)/i.test(type)) {
      const { channelData, sampleRate } = await this.decode(body)
      const channels = Math.min(channelData.length, 2)
      const frames = channelData[0]?.length ?? 0
      if (!frames || !sampleRate) {
        this.logger.error(`OpenRouter TTS mp3 decoded to no audio (${body.length} bytes)`)
        return null
      }
      const samples = new Int16Array(frames * channels)
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
          const v = Math.max(-1, Math.min(1, channelData[c][i]))
          samples[i * channels + c] = v < 0 ? v * 0x8000 : v * 0x7fff // f32 to s16
        }
      }
      return toStereo48k(samples, sampleRate, channels)
    }

    this.logger.error(`OpenRouter TTS returned unsupported content type (${type || 'no content type'}, ${body.length} bytes)`)
    return null
  }
}

// Interleaved s16 at any rate to 48kHz stereo by linear interpolation, keeping the first two channels
function toStereo48k(input: Int16Array, rate: number, channels: number) {
  if (rate === 48000 && channels === 2) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  const frames = input.length / channels
  const step = rate / 48000
  const output = new Int16Array(Math.round(frames / step) * 2)
  for (let i = 0; i < output.length / 2; i++) {
    const pos = i * step
    const j = Math.floor(pos)
    const k = Math.min(j + 1, frames - 1)
    for (let c = 0; c < 2; c++) {
      const ch = Math.min(c, channels - 1)
      output[i * 2 + c] = Math.round(input[j * channels + ch] + (input[k * channels + ch] - input[j * channels + ch]) * (pos - j))
    }
  }
  return new Uint8Array(output.buffer)
}
