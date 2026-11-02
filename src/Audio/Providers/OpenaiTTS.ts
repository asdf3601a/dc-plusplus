import { existsSync as exists } from 'node:fs'
import type { ILogObj, Logger } from 'tslog'
import { OPENAI_TOKEN_FILE, openaiAccessToken } from '../../Utils/OpenaiOAuth'
import { fetchWithRetry } from '../FetchWithRetry'
import type { TTSProvider } from '../TTSProvider'

const MODEL = 'gpt-realtime-2.1-mini'
// Node's WebSocket (undici) takes headers, which the DOM typings used here leave out
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket

interface ServerEvent {
  type: string
  delta?: string
  error?: { message?: string }
  // biome-ignore lint/style/useNamingConvention: OpenAI API field
  response?: { status?: string; status_details?: unknown }
}

// OpenAI Realtime over a WebSocket, one connection per text. The Realtime pcm is 24kHz mono s16le,
// converted to 48kHz stereo. Without openaiTTS.apiKey, the ChatGPT login is exchanged for a client secret
// (an ephemeral key) for each connection
export class OpenaiTTS implements TTSProvider {
  public readonly id = 'openai'
  public readonly format = 'pcm'
  public readonly usesVoice = true
  private logger: Logger<ILogObj>
  private apiKey: () => string

  constructor(apiKey: () => string, logger: Logger<ILogObj>) {
    this.apiKey = apiKey
    this.logger = logger.getSubLogger({ name: 'OpenaiTTS' })
  }

  public unavailableReason() {
    return this.apiKey() || exists(OPENAI_TOKEN_FILE) ? undefined : 'openaiTTS.apiKey is not set in config.json and there is no OpenAI login (run `pnpm openai:login`)'
  }

  private async clientSecret(voice: string, signal: AbortSignal) {
    const token = await openaiAccessToken()
    const res = await fetchWithRetry('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      // biome-ignore lint/style/useNamingConvention: HTTP header
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: { type: 'realtime', model: MODEL, audio: { output: voice ? { voice } : {} } } }),
      signal
    })
    const data = await res.json().catch(() => undefined)
    if (!res.ok || typeof data?.value !== 'string') {
      const detail = String(data?.error?.message ?? 'no client secret').replaceAll(token, '<redacted>')
      throw new Error(`client_secrets responded ${res.status}: ${detail}`)
    }
    return data.value
  }

  public async synthesize(text: string, lang: string, voice: string, signal: AbortSignal): Promise<Uint8Array | null> {
    if (signal.aborted) {
      this.logger.error('OpenAI Realtime TTS failed: aborted at the synthesis time limit')
      return null
    }
    let key = this.apiKey()
    if (!key) {
      try {
        key = await this.clientSecret(voice, signal)
      } catch (error) {
        this.logger.error(`OpenAI Realtime TTS failed: ${error instanceof Error ? error.message : error}`)
        return null
      }
    }
    return new Promise((resolve) => {
      if (signal.aborted) {
        this.logger.error('OpenAI Realtime TTS failed: aborted at the synthesis time limit')
        return resolve(null)
      }
      const chunks: Buffer[] = []
      // biome-ignore lint/style/useNamingConvention: HTTP header
      const ws = new NodeWebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, { headers: { Authorization: `Bearer ${key}` } })

      const finish = (error?: string) => {
        signal.removeEventListener('abort', onAbort)
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        ws.close()
        if (error) this.logger.error(`OpenAI Realtime TTS failed: ${error}`)
        resolve(error ? null : toStereo48k(Buffer.concat(chunks)))
      }
      const onAbort = () => finish('aborted at the synthesis time limit')
      signal.addEventListener('abort', onAbort)

      ws.onopen = () => {
        const send = (event: object) => ws.send(JSON.stringify(event))
        send({
          type: 'session.update',
          session: {
            type: 'realtime',
            // biome-ignore lint/style/useNamingConvention: OpenAI API field
            output_modalities: ['audio'],
            instructions: `Read the user's text aloud exactly as written, word for word. Do not answer it, rephrase it or add anything. The language is ${lang}.`,
            audio: { output: { format: { type: 'audio/pcm', rate: 24000 }, ...(voice ? { voice } : {}) } }
          }
        })
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
        send({ type: 'response.create' })
      }
      ws.onmessage = ({ data }) => {
        let event: ServerEvent
        try {
          event = JSON.parse(data)
        } catch {
          return finish('the server sent an event that is not JSON')
        }
        if (event.type === 'response.output_audio.delta') {
          chunks.push(Buffer.from(event.delta ?? '', 'base64'))
        } else if (event.type === 'error') {
          finish(`server error: ${event.error?.message ?? 'no error details'}`)
        } else if (event.type === 'response.done') {
          const status = event.response?.status
          if (status !== 'completed') finish(`response ${status}: ${JSON.stringify(event.response?.status_details ?? null)}`)
          else finish(chunks.length ? undefined : 'no audio in the response')
        }
      }
      ws.onerror = () => finish('connection error')
      ws.onclose = ({ code, reason }) => finish(`connection closed early (${code}${reason ? ` ${reason}` : ''})`)
    })
  }
}

// 24kHz mono s16 to 48kHz stereo s16, with a linearly interpolated sample in between
function toStereo48k(mono: Buffer) {
  const pcm = new Int16Array((mono.length >> 1) * 4)
  let previous = 0
  for (let i = 0; i < mono.length >> 1; i++) {
    const sample = mono.readInt16LE(i * 2)
    const middle = Math.round((previous + sample) / 2)
    pcm.set([middle, middle, sample, sample], i * 4)
    previous = sample
  }
  return new Uint8Array(pcm.buffer)
}
