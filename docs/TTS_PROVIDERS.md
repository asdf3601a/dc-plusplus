# Adding a TTS provider

A TTS provider turns text into audio bytes. Caching, queueing and playback are done by the audio module, so a provider is one class plus a line that registers it. The existing ones are in `src/Audio/Providers/`: `GoogleTranslateTTS.ts`, `GoogleCloudTTS.ts`, `XaiTTS.ts` and `OpenaiTTS.ts`.

## The provider

Add `src/Audio/Providers/<Name>TTS.ts` with a class that implements `TTSProvider` from `src/Audio/TTSProvider.ts`:

- `id`: the provider id, for example `google-cloud`. It is the value of `"provider"` in a TTS file, a `/voice tts` choice, and part of the cache key, so do not change it later.
- `format`: `'ogg'` for OGG Opus, or `'pcm'` for raw 48 kHz stereo signed 16-bit little-endian. Convert anything else to one of these (`GoogleTranslateTTS` decodes mp3 to pcm; `XaiTTS` copies its mono pcm to both channels).
- `usesVoice`: `false` when the provider has no voices. The voice is then always empty and left out of the cache key.
- `unavailableReason()`: why the provider cannot be used right now, such as a missing API key, or `undefined`. `/voice tts` refuses a provider with a reason and logs the reason.
- `synthesize(text, lang, voice, signal)`: resolves to the audio bytes, or `null` on failure. Log the failure in English with the provider's logger and return `null`; do not throw.

`lang` and `voice` come from the TTS file, or from `voice_lang` and `voice_name` of `/voice tts` for voice messages. Send them as given; they never go in the config.

An HTTP provider sends every request through `fetchWithRetry` from `src/Audio/FetchWithRetry.ts` and passes it `signal`. It retries a 429, a 5xx or a network error up to twice, after 0.5 s then 1 s or the `Retry-After`, and returns the last response or throws the last error. A provider that does not use HTTP decides whether to retry and how to handle abort. `signal` aborts at the 30 second synthesis limit. Work that does not follow the signal, like decoding, is cut off by the same limit in `AudioCache`, which then logs an error and discards a late result.

`AudioCache` stores the result in `caches/` under the md5 of `<id>:<text>-<lang>-<voice>`, with the extension `.opus` or `.pcm`. A `null` or empty result is never cached, so the next announcement tries again.

## Registering it

Add an instance to `providers` in `src/Utils/Instances.ts`. Nothing else lists providers: the `/voice tts` choices, TTS files with `"provider"` and voice messages all take the ids from there. The `/voice tts` choices are registered with Discord when the bot starts, so restart it. The bot's own announcements stay on `systemProvider` (`google-cloud`).

## Credentials

An API key goes in `config.json` as `<name>TTS.apiKey`, like `googleTTS.apiKey` and `xaiTTS.apiKey`. Pass it to the provider as a getter, `() => config.<name>TTS.apiKey`. Tokens from a login (OAuth) go in a fixed file in the project root with mode 0600, added to `.gitignore`, like `xai-oauth.json`. Never use `.env`, the home directory or any path outside the project.

A new config section in `src/Utils/Config.ts` needs its interface, a field in `ConfigValue`, a default, the merge in the constructor (`if (!config.<name>TTS) config.<name>TTS = {}` and then one value per field, like `xaiTTS`), the default in the branch that creates a new config, a line in `save()` and a getter. Any config addition bumps `configVersion`: on the first start with the new code, the bot backs up the old file to `config-<old version>.json`, writes the new one and exits with code 78 (see [Exit code 78](UPGRADING.md#exit-code-78)). Update the README note about the first start after upgrading to name the new version.

## Checklist

1. `src/Audio/Providers/<Name>TTS.ts` implements `TTSProvider`, and `synthesize` logs and returns `null` on failure.
2. An HTTP provider sends every request through `fetchWithRetry` with `signal`. A provider that does not use HTTP decides whether to retry and how to handle abort.
3. The provider is in `providers` in `src/Utils/Instances.ts`.
4. Credentials are in `config.json` or a git-ignored 0600 file in the project root, never `.env` or outside the project.
5. A config addition bumps `configVersion` and updates the README upgrade note.
6. The README has a setup section like the Google and xAI ones: what to set or run, the TTS file, and where `lang` and `voice` come from.
7. `pnpm build` and `pnpm biome:ci` pass.

## Skeleton

```ts
import type { ILogObj, Logger } from 'tslog'
import { fetchWithRetry } from '../FetchWithRetry'
import type { TTSProvider } from '../TTSProvider'

// Example TTS, OGG Opus
export class ExampleTTS implements TTSProvider {
  public readonly id = 'example'
  public readonly format = 'ogg'
  public readonly usesVoice = true
  private logger: Logger<ILogObj>
  private apiKey: () => string

  constructor(apiKey: () => string, logger: Logger<ILogObj>) {
    this.apiKey = apiKey
    this.logger = logger.getSubLogger({ name: 'ExampleTTS' })
  }

  public unavailableReason() {
    return this.apiKey() ? undefined : 'exampleTTS.apiKey is not set in config.json'
  }

  public async synthesize(text: string, lang: string, voice: string, signal: AbortSignal): Promise<Uint8Array | null> {
    try {
      const res = await fetchWithRetry('https://tts.example.com/v1/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey() },
        body: JSON.stringify({ text, lang, voice }),
        signal
      })
      if (!res.ok) {
        this.logger.error(`Example TTS API responded ${res.status}`)
        return null
      }
      return new Uint8Array(await res.arrayBuffer())
    } catch (error) {
      this.logger.error(`Example TTS request failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }
}
```

Then in `src/Utils/Instances.ts`:

```ts
const providers = [/* ... */, new ExampleTTS(() => config.exampleTTS.apiKey, mainLogger)]
```
