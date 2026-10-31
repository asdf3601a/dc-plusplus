# TTS Provider Migration

Older `assets/<User ID>.json` files chose the TTS engine with `use_wave_tts` instead of naming a `provider`. `pnpm migrate` converts them to the new format.

## When

The conversion is the step from [data version](../../README.md#data-version) 1 to 2. `pnpm migrate` runs it once, after the database migrations, when the recorded data version is older than 2 (an install from before data versions counts as version 1). It first [backs up](../../README.md#backups) the database and `assets/` (unless `--yolo`), then rewrites each old-format file in place. `.wav` files are never touched. Once version 2 is recorded the conversion does not run again: a file added later must use `provider`, and the bot skips a file without a usable `provider` with an error. See [Upgrading](../../README.md#upgrading) for the whole procedure.

## How

| Old file | New `provider` |
| --- | --- |
| `"use_wave_tts": true` with a `voice` | `google-cloud` |
| `"use_wave_tts": true` without a `voice` | `google-translate` |
| `"use_wave_tts": false` | `google-translate` |
| no `use_wave_tts` and no `provider` | `google-translate` |

This matches how the old versions actually behaved: `use_wave_tts` without a `voice` fell back to Google Translate. A file that already has a `provider` keeps it, and `use_wave_tts` is removed. Every other key (`lang`, `voice`, `join`, `left`, `switched_out`, `switched_in`, ...) is kept as it was.

A file that is not valid JSON or not a JSON object fails the run before anything is changed, and the error lists every such file. Fix or remove them, or run `pnpm migrate --skip-invalid` to leave them unconverted (see [Data version](../../README.md#data-version)).

Example: this old file

```json
{
  "use_wave_tts": true,
  "lang": "en-GB",
  "voice": "en-GB-Wavenet-B",
  "join": "Jim joined the channel"
}
```

becomes

```json
{
  "provider": "google-cloud",
  "lang": "en-GB",
  "voice": "en-GB-Wavenet-B",
  "join": "Jim joined the channel"
}
```
