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
2. Run `pnpm migrate`. It first checks the data version record and the assets, and stops before touching the database if the record is malformed or newer than the code or an asset file is invalid (see below). It then waits up to about 10 seconds if another connection holds the database locked, stops there if there is nothing to migrate, [backs up](#backups) the database and `assets/`, applies pending database migrations (`prisma migrate deploy`), imports a MongoDB dump if you pass `--import-mongo` (see [Database Migration](#database-migration)), and upgrades `assets/<User ID>.json` to the current [data version](#data-version). Running it again changes nothing and makes no backup.
3. Run `pnpm start`.

The bot never migrates on its own: if the database has unapplied migrations, the data version is older than the code's, or a MongoDB dump is waiting to be imported, it logs ``請先執行 `pnpm migrate` `` (for the dump: run `pnpm migrate --import-mongo` or move the file away) and exits with code 78. It also exits with code 78, after logging an error, when the data version record is malformed or newer than the code. pm2 does not restart the bot on code 78 (`stop_exit_codes` in `ecosystem.config.js`). `pm2 deploy` runs `pnpm migrate` (without `--yolo`) in its post-deploy step before reloading the bot, so a deploy makes a backup only when it has something to migrate.

### Backups

`pnpm migrate` makes a backup only when there is something to migrate: unapplied database migrations, a data version record that is missing or older than the code's, or a MongoDB dump (the one passed to `--import-mongo`, or `./mongo_dump.json` if it is there). When there is none of these, it changes nothing, makes no backup and exits with code 0; `--yolo` and `--backup-dir` then exit with code 1, since there is no backup to skip or place. A release that changes neither the database nor the data format therefore makes no backup; if you may want to go back to an older version of the bot, back up yourself first. Before it changes anything, `pnpm migrate` backs up all the data to a new directory `backup/<YYYYMMDD-HHmmss-SSS>/` (with `-1`, `-2`, ... if that name is taken), whatever this run changes: the database (a consistent copy, even while the bot is running), every file in `assets/`, `data-version.json`, and the MongoDB dump: the one passed to `--import-mongo` (it is deleted after the import), or, without `--import-mongo`, `./mongo_dump.json` (or `MONGODB_DUMP_PATH`) if it is there. `--backup-dir <path>` puts the backup in `<path>/<YYYYMMDD-HHmmss-SSS>/` instead; `<path>` must not be inside `assets/`, since that is backed up and restored whole. Each backup has a `manifest.json` listing every file with its original path and sha256 (and the paths that did not exist yet, such as `data-version.json` on an install from before data versions); right after writing it, `pnpm migrate` checks every hash and the copied database (`PRAGMA integrity_check`), and stops, having changed nothing, if anything is off. It then logs the backup's path. A fresh install (no database, no `assets/`, no record), `--preflight` and a run with nothing to migrate make no backup. An existing backup is never overwritten, and old backups are never deleted; remove them yourself. If the backup fails, `pnpm migrate` exits with code 1 before changing anything; fix the problem (e.g. a file named `backup`, or a full disk) and run it again. `pnpm migrate --yolo` skips the backup (it only logs a warning); back up yourself first.

If a run fails after the backup, the error says what it changed (for a failed database migration: whether it was rolled back, which needs its SQL to run in a transaction) and how to undo it.

To restore a backup, stop the bot and run `pnpm migrate --restore <path to the backup directory>`. It first checks the whole backup (the manifest, every sha256, and the database's integrity) and exits with code 1, changing nothing, if anything is off. It then backs up the current data (the database file as it is, `assets/` and the other files in the manifest) to a new directory in `backup/` (or `--backup-dir`) and logs its path, so `pnpm migrate --restore <that path>` undoes the restore. Then it puts the database, `assets/`, `data-version.json` and the dump back as they were: the database's `-wal` / `-shm` files are deleted, as are files the backup recorded as not existing and files in `assets/` that the backup does not have (they are in the backup of the current data). It does not migrate: `pnpm start` exits with code 78 until you run `pnpm migrate` again, unless you run the version of the bot that matches the restored data. `--restore` cannot be combined with `--yolo`, `--preflight`, `--import-mongo` or `--skip-invalid`, and refuses a backup directory inside `assets/` for the same reason as `--backup-dir`.

### A failed database migration

Each database migration runs in one transaction, so when `prisma migrate deploy` fails (or is killed) the failed migration is rolled back and the database is left as it was. `pnpm migrate` then exits with code 1 before importing a dump or converting `assets/`, and the bot keeps refusing to start (code 78). Prisma still records the migration as failed: the failing run reports `P3018` with the database error and the migration name, and every later run reports `P3009` until it is resolved. Fix the cause shown by `P3018`, then mark the migration as rolled back and migrate again:

```bash
pnpm exec prisma migrate resolve --rolled-back <migration name, e.g. 20261030120000_tts_provider>
pnpm migrate
```

## Data version

The database is versioned by Prisma's migration history (`prisma/migrations`). The app-side data, `assets/<User ID>.json`, has its own version, `DATA_VERSION` in `src/Migration/index.ts` (currently `2`), recorded in `data-version.json` next to the database file (by default `prisma/data-version.json`), e.g. `{ "version": 2 }`.

`pnpm migrate` and the data version:
- No record and no `assets/*.json`: a fresh install; the current version is recorded and nothing is converted.
- No record but some `assets/*.json`: an install from before data versions (version 1).
- Older version: the files are [backed up](#backups) (unless `--yolo`), then converted in place, one version at a time. The new version is recorded only after every file was converted; on a failure the old version stays and running `pnpm migrate` again finishes the job.
- An `assets/*.json` that is not a JSON object (invalid JSON, an array, ...) fails the run before the database is migrated or anything is converted, and the error lists every such file. Fix or remove them, or run `pnpm migrate --skip-invalid` (or `pnpm migrate -- --skip-invalid`; the option applies to every step) to leave them unconverted and record the new version anyway (the bot then skips those files with an error).
- Newer version (a downgrade) or a malformed record: an error is logged, nothing is changed (the database is not migrated either), `pnpm migrate` exits with code 1 and `pnpm start` with code 78.

Rules for contributors:
- Bump `DATA_VERSION` only for a breaking change to the assets format, at most once per PR, with exactly one step for the bump in `ASSET_STEPS` (`src/Migration/assets/steps.ts`).
- Database changes go into a new Prisma migration. Never edit a released migration; this release adds `prisma/migrations/20261030120000_tts_provider`.
- Prisma does not wrap SQLite migrations in a transaction: a migration with more than one statement puts them between `BEGIN;` and `COMMIT;` (with `PRAGMA foreign_keys` outside, where SQLite honours it), so that a failure leaves nothing half done.

## Database Migration

If you are upgrading from an older version that used MongoDB, please refer to the [Migration Guide](docs/migration/MONGODB_TO_SQLITE_MIGRATION.md) to move your data to SQLite. In short: put the `mongoexport` dump at `./mongo_dump.json` (or set `MONGODB_DUMP_PATH`) and run `pnpm migrate --import-mongo` (or `pnpm migrate --import-mongo <path>`). It imports every document in one transaction, so an invalid dump imports nothing, then deletes the dump (after [backing it up](#backups) with the database and `assets/`, unless `--yolo`). `pnpm migrate` without `--import-mongo` never imports. `pnpm start` refuses to start (exit code 78) while the dump file is present.

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
