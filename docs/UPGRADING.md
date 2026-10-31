# Upgrading

The upgrade steps are in the [README](../README.md#upgrading). This page explains what `pnpm migrate` does, when the bot exits with code 78, the backups `pnpm migrate` makes, how to restore one and what to do when a migration fails.

## What `pnpm migrate` does

`pnpm migrate` first checks the data version record and the assets, and stops before touching the database if the record is malformed or newer than the code or an asset file is invalid (see [Data version](#data-version)). It then waits up to about 10 seconds if another connection holds the database locked, stops there if there is nothing to migrate, [backs up](#backups) the data, applies pending database migrations (`prisma migrate deploy`), imports the MongoDB dump if there is one (see the [MongoDB to SQLite migration guide](migration/MONGODB_TO_SQLITE_MIGRATION.md)), and upgrades `assets/<User ID>.json` to the current [data version](#data-version). Running it again changes nothing and makes no backup.

## Exit code 78

The bot never migrates on its own. It exits with code 78 when it needs you before it can run:

- The database has unapplied migrations, the data version is older than the code's, or a MongoDB dump (`./mongo_dump.json`, or `MONGODB_DUMP_PATH`) is waiting to be imported. It logs ``請先執行 `pnpm migrate` ``.
- The data version record is malformed or newer than the code. It logs an error.
- `prisma/migrations` is missing, for example because the bot was started from another directory. It logs the missing path.
- `config.json` does not exist. The bot generates an empty one; fill it in and start the bot again.
- `config.json` has a config version newer than the code.
- `config.json` has an older config version. The bot backs it up to `config-<old version>.json`, writes the migrated config and exits. Check `config.json`, then start the bot again yourself: pm2 does not restart it.

`pnpm migrate` loads `config.json` too, so it also exits with code 78 in the three `config.json` cases; run it again once the config is ready.

pm2 does not restart the bot on code 78 (`stop_exit_codes` in `ecosystem.config.js`). `pm2 deploy` runs `pnpm install`, `pnpm db:generate`, `pnpm build:prod` and `pnpm migrate` (without `--yolo`) in its post-deploy step before reloading the bot, so a deploy makes a backup only when it has something to migrate. If one of these steps fails, the bot is not reloaded.

## Backups

`pnpm migrate` makes a backup only when there is something to migrate: unapplied database migrations, a data version record that is missing or older than the code's, or a MongoDB dump (`./mongo_dump.json`, or `MONGODB_DUMP_PATH`). When there is none of these, it changes nothing, makes no backup and exits with code 0; `--yolo` and `--backup-dir` then exit with code 1, since there is no backup to skip or place. A release that changes neither the database nor the data format therefore makes no backup; if you may want to go back to an older version of the bot, back up yourself first.

Before it changes anything, `pnpm migrate` backs up all the data to a new directory `backup/<YYYYMMDD-HHmmss-SSS>/` (with `-1`, `-2`, ... if that name is taken), whatever this run changes: the database (a consistent copy, even while the bot is running), every file in `assets/`, `data-version.json`, and the MongoDB dump if there is one (it is deleted after the import). `--backup-dir <path>` puts the backup in `<path>/<YYYYMMDD-HHmmss-SSS>/` instead; `<path>` must not be inside `assets/`, since that is backed up and restored whole.

Each backup has a `manifest.json` listing every file with its original path and sha256 (and the paths that did not exist yet, such as `data-version.json` on an install from before data versions). Right after writing it, `pnpm migrate` checks every hash and the copied database (`PRAGMA integrity_check`), and stops, having changed nothing, if anything is off. It then logs the backup's path.

A fresh install (no database, no `assets/`, no record), `--preflight` and a run with nothing to migrate make no backup. An existing backup is never overwritten, and old backups are never deleted; remove them yourself. If the backup fails, `pnpm migrate` exits with code 1 before changing anything; fix the problem (e.g. a file named `backup`, or a full disk) and run it again. `pnpm migrate --yolo` skips the backup (it only logs a warning); back up yourself first.

## Restoring a backup

Stop the bot first. `pnpm migrate --restore` waits while another connection is in the middle of a transaction on the database, but it cannot see a bot that is running and idle, and would replace the database under it.

Then run `pnpm migrate --restore <path to the backup directory>`. It first checks the whole backup (the manifest, every sha256, and the database's integrity) and exits with code 1, changing nothing, if anything is off. It then backs up the current data (the database file as it is, `assets/` and the other files in the manifest) to a new directory in `backup/` (or `--backup-dir`) and logs its path, so `pnpm migrate --restore <that path>` undoes the restore. Then it puts the database, `assets/`, `data-version.json` and the dump back as they were: the database's `-wal` / `-shm` files are deleted, as are files the backup recorded as not existing and files in `assets/` that the backup does not have (they are in the backup of the current data).

It does not migrate: `pnpm start` exits with code 78 until you run `pnpm migrate` again, unless you run the version of the bot that matches the restored data. `--restore` cannot be combined with `--yolo`, `--preflight` or `--skip-invalid`, and refuses a backup directory inside `assets/` for the same reason as `--backup-dir`.

## A failed migration

If a run fails after the backup, the error says what it changed (for a failed database migration: whether it was rolled back, which needs its SQL to run in a transaction) and how to undo it.

Each database migration runs in one transaction, so when `prisma migrate deploy` fails (or is killed) the failed migration is rolled back and the database is left as it was. `pnpm migrate` then exits with code 1 before importing a dump or converting `assets/`, and the bot keeps refusing to start (code 78). Prisma still records the migration as failed: the failing run reports `P3018` with the database error and the migration name, and every later run reports `P3009` until it is resolved. Fix the cause shown by `P3018`, then mark the migration as rolled back and migrate again:

```bash
pnpm prisma migrate resolve --rolled-back <migration name, e.g. 20261030120000_tts_provider>
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

Rules for changing the data version or the database are in [DATA_VERSION.md](DATA_VERSION.md).
