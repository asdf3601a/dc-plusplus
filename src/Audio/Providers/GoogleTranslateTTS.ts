import type { MPEGDecoderWebWorker } from 'mpg123-decoder'
import type { ILogObj, Logger } from 'tslog'
import { fetchWithRetry } from '../FetchWithRetry'
import type { SynthesisSignal, TTSProvider } from '../TTSProvider'

// Google Translate TTS, decoded to 48kHz stereo s16 PCM
export class GoogleTranslateTTS implements TTSProvider {
  public readonly id = 'google-translate'
  public readonly format = 'pcm'
  public readonly usesVoice = false
  private logger: Logger<ILogObj>
  private mp3Decoder: MPEGDecoderWebWorker
  // The decoder keeps state between decode() and reset(), so decodes run one at a time
  private decoding: Promise<unknown> = Promise.resolve()

  constructor(logger: Logger<ILogObj>) {
    this.logger = logger.getSubLogger({ name: 'GoogleTranslateTTS' })
    this.mp3Decoder = new (require('fix-esm').require('mpg123-decoder').MPEGDecoderWebWorker)()
  }

  public unavailableReason() {
    return undefined
  }

  private decode(mp3: Uint8Array) {
    const run = this.decoding.then(async () => {
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

  public async synthesize(text: string, lang: string, _voice: string, signal: SynthesisSignal): Promise<Uint8Array | null> {
    // URLSearchParams encodes &, # and ? in the text, which encodeURI left as URL syntax
    const ttsURL = `https://translate.google.com.tw/translate_tts?${new URLSearchParams({ ie: 'UTF-8', q: text, tl: lang, client: 'tw-ob' })}`
    try {
      const res = await fetchWithRetry(ttsURL, { signal })
      if (!res.ok) {
        this.logger.error(`TTS ${text} in ${lang} download failed. response code: ${res.status}`)
        return null
      }
      const mp3 = new Uint8Array(await res.arrayBuffer())
      // Decode mp3 to PCM 24kHz mono f32
      const { channelData } = await this.decode(mp3)

      // Covent to 48kHz stereo s16
      const pcm = new Int16Array(channelData[0].length * 4)
      let temp = 0
      channelData[0].forEach((v, index) => {
        const i = v < 0 ? v * 0x8000 : v * 0x7fff // f32 to s16

        // Linear interpolation
        const i1 = Math.round((temp + i) / 2)
        const i2 = Math.round(i)
        temp = i

        pcm.set([i1, i1, i2, i2], index * 4) // 24kHz mono to 48kHz stereo
      })
      return new Uint8Array(pcm.buffer)
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`TTS ${text} in ${lang} download failed: ${error.message}`, error)
      }
      return null
    }
  }
}
