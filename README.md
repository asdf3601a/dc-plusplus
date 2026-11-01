# Discord-Voice-log [![CircleCI](https://circleci.com/gh/jimchen5209/Discord-Voice-log.svg?style=svg)](https://circleci.com/gh/jimchen5209/Discord-Voice-log)

## How to use

1. Install [node.js](https://nodejs.org/en/) (Recommend using [nvm](https://github.com/nvm-sh/nvm)), [pnpm](https://pnpm.io/), [ffmpeg](https://ffmpeg.org/)
2. Clone this repo
3. Install dependencies with `pnpm install`
4. Generate Prisma Client:
  ```bash
  pnpm db:generate
  ```
5. Build with `pnpm build:prod`
6. Run `node dist` the first time to generate `config.json`
7. Fill `config.json` with your bot tokens and settings.
8. Initialize the database and data with:
  ```bash
  pnpm migrate
  ```
  *(Note: This project now uses SQLite via Prisma ORM (v7) with `better-sqlite3` driver for simplified setup)*
9. Install `pm2` via `npm install -g pm2` (Optional but recommended)
10. Start the bot with `pnpm start` (same as `node dist`) or `pm2 reload ecosystem.config.js`
11. When inviting bot to your server, be sure to enable these permission at least  
![image](https://user-images.githubusercontent.com/10269287/149659808-a51a571f-7ef2-43cf-b415-6220a56847a4.png)  
12. This bot uses slash command, type `/` in server chat and start configuring the bot
![image](https://user-images.githubusercontent.com/10269287/149659879-8be3aecb-d8b6-4a7c-b06f-43776dfe2233.png)

## Upgrading

1. Stop the bot.
2. `git pull`
3. `pnpm install`
4. `pnpm db:generate`
5. `pnpm build:prod`
6. `pnpm migrate` (when there is something to migrate, it backs up your data first)
7. `pnpm start`

The bot does not migrate on its own: when its data needs migrating, it exits with code 78, and pm2 does not restart it. For backups, restoring one and what to do when a migration fails, see [docs/UPGRADING.md](docs/UPGRADING.md).

## Database Migration

If you are upgrading from an older version that used MongoDB, see the [MongoDB to SQLite migration guide](docs/migration/MONGODB_TO_SQLITE_MIGRATION.md); `pnpm migrate` imports the `mongoexport` dump when it finds one.

## Voice Activity Sound

 For the voice activity sound, put the following file into `assets/` folder:
```
<User ID>_join.wav --Connected to the channel
<User ID>_left.wav --Left the channel
<User ID>_switched_out.wav --Switched out from the channel
<User ID>_switched_in.wav --Switched into the channel
```
or place `<User ID>.json` into `assets/` folder with:
```json
{
  "provider": "google-translate",
  "lang": "<language from google translate>",
  "join": "<Text when connected to the channel>",
  "left": "<Text when left the channel>",
  "switched_out": "<Text when switched out from the channel>",
  "switched_in": "<Text when switched into to the channel>"
}
```
If you want to use the new google cloud text to speech, be sure to have apiKey in the config, and json content is:
```json
{
  "provider": "google-cloud",
  "lang": "<language from google cloud>",
  "voice": "<voice from google cloud>",
  "join": "<Text when connected to the channel>",
  "left": "<Text when left the channel>",
  "switched_out": "<Text when switched out from the channel>",
  "switched_in": "<Text when switched into to the channel>"
}
```
`lang` and `voice` available from https://cloud.google.com/text-to-speech/docs/voices

For xAI text to speech, use `"provider": "xai"` with the same fields. Set `xaiTTS.apiKey` in the config, or sign in once with `pnpm xai:login`. The login uses the Grok CLI's public OAuth client and prints a link and a code to approve in the browser. Run it from the project root after `pnpm build`.

The API key is used whenever it is set. The login is written to `xai-oauth.json` in the project root (mode 0600), with the access and refresh tokens. Treat `xaiTTS.apiKey` and `xai-oauth.json` like passwords: do not commit or share them. Delete `xai-oauth.json` to sign out. The bot refreshes the token itself; refreshes coordinate through `xai-oauth.json.lock`.

If a refresh fails, or `xai-oauth.json` is not a valid login, the bot logs an error asking you to run `pnpm xai:login` again and skips that text; it keeps running. With the login, a 401 means the token was revoked: run `pnpm xai:login` again, and a 403 means the login can't use the API: set `xaiTTS.apiKey` instead. A 429, a 5xx or a network error is retried up to twice, within the 30 second limit for that text.

`lang` is an [xAI language code](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#supported-languages) or `auto`, and `voice` is an [xAI voice](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#voices) (built-in such as `eve`, or a custom voice ID). Both are sent as given. An empty `voice` lets xAI pick its default. When a server's `/voice tts` switches to xai, also set `voice_lang` and `voice_name` to xAI values. In the config, `xaiTTS` is only the API key:

```json
{
  "apiKey": ""
}
```

After upgrading, the first start exits; check `config.json` and start again.

The TTS file is:

```json
{
  "provider": "xai",
  "lang": "<xAI language code, or auto>",
  "voice": "<xAI voice, such as eve, or a custom voice ID>",
  "join": "<Text when connected to the channel>",
  "left": "<Text when left the channel>",
  "switched_out": "<Text when switched out from the channel>",
  "switched_in": "<Text when switched into to the channel>"
}
```

Files in the old format (`use_wave_tts` instead of `provider`) are converted by `pnpm migrate` when upgrading to [data version](docs/UPGRADING.md#data-version) 2; see the [TTS provider migration guide](docs/migration/TTS_PROVIDER_MIGRATION.md). Files added later must use `provider`; files without a usable `provider` are skipped with an error.

Example:

```json
{
  "provider": "google-translate",
  "lang": "en_US",
  "join": "Jim joined the channel",
  "left": "Jim left the channel",
  "switched_out": "Jim switched out from the channel",
  "switched_in": "Jim switched into  the channel"
}
```
```json
{
  "provider": "google-cloud",
  "lang": "en-GB",
  "voice": "en-GB-Wavenet-B",
  "join": "Jim joined the channel",
  "left": "Jim left the channel",
  "switched_out": "Jim switched out from the channel",
  "switched_in": "Jim switched into  the channel"
}
```
```json
{
  "provider": "xai",
  "lang": "en",
  "voice": "eve",
  "join": "Jim joined the channel",
  "left": "Jim left the channel",
  "switched_out": "Jim switched out from the channel",
  "switched_in": "Jim switched into  the channel"
}
```
