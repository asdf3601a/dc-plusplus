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

1. Stop the bot and back up the database file (by default `prisma/voice-log.db`). Database migrations are **not** backed up automatically.
2. Run `pnpm migrate`. It applies pending database migrations (`prisma migrate deploy`), then upgrades `assets/<User ID>.json` to the current [data version](#data-version). Running it again changes nothing.
3. Run `pnpm start`.

The bot never migrates on its own: if the database has unapplied migrations or the data version is older than the code's, it logs ``請先執行 `pnpm migrate` `` and exits with code 78, which pm2 does not restart (`stop_exit_codes` in `ecosystem.config.js`). `pm2 deploy` runs `pnpm migrate` in its post-deploy step before reloading the bot.

## Data version

The database is versioned by Prisma's migration history (`prisma/migrations`). The app-side data, `assets/<User ID>.json`, has its own version, `DATA_VERSION` in `src/Core/DataMigration.ts` (currently `2`), recorded in `data-version.json` next to the database file (by default `prisma/data-version.json`), e.g. `{ "version": 2 }`.

`pnpm migrate` and the data version:
- No record and no `assets/*.json`: a fresh install; the current version is recorded and nothing is converted.
- No record but some `assets/*.json`: an install from before data versions (version 1).
- Older version: the files that need converting are copied to `backup/assets-<YYYYMMDD-HHmmss>/` (never overwriting an existing backup), then converted one version at a time. The new version is recorded only after every file was converted; on a failure the old version stays and running `pnpm migrate` again finishes the job.
- Newer version (a downgrade) or a malformed record: an error is logged, nothing is converted, and both `pnpm migrate` and `pnpm start` exit with an error.

Rules for contributors:
- Bump `DATA_VERSION` only for a breaking change to the assets format, at most once per PR, with exactly one step for the bump in `ASSET_STEPS` (`src/Audio/AssetsMigration.ts`).
- Database changes go into a new Prisma migration. Never edit a released migration; this release adds `prisma/migrations/20261030120000_tts_provider`.

## Database Migration

If you are upgrading from an older version that used MongoDB, please refer to the [Migration Guide](docs/migration/MONGODB_TO_SQLITE_MIGRATION.md) to move your data to SQLite.

## Voice Activity Sound

 For the voice activity sound, put the following file into `asset/` folder:
```
<User ID>_join.wav --Connected to the channel
<User ID>_left.wav --Left the channel
<User ID>_switched_out.wav --Switched out from the channel
<User ID>_switched_in.wav --Switched into the channel
```
or place `<User ID>.json` into `asset/` folder with:
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

Files in the old format (`"use_wave_tts": true` / `false` or missing instead of `provider`) are converted by `pnpm migrate` when upgrading to [data version](#data-version) 2: `"use_wave_tts": true` with a `voice` becomes `"provider": "google-cloud"`; anything else (`false`, missing, or `true` without a `voice`) becomes `"provider": "google-translate"`, matching how it actually behaved before. Files that already have `provider` keep it. Files added later must use `provider`; files without a usable `provider` are skipped with an error.

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
