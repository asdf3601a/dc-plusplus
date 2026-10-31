# Data version: rules for contributors

How `pnpm migrate` uses the data version is described in [Upgrading](UPGRADING.md#data-version). When you change the assets format or the database:

- Bump `DATA_VERSION` only for a breaking change to the assets format, at most once per PR, with exactly one step for the bump in `ASSET_STEPS` (`src/Migration/assets/steps.ts`).
- Database changes go into a new Prisma migration. Never edit a released migration; this release adds `prisma/migrations/20261030120000_tts_provider`.
- Prisma does not wrap SQLite migrations in a transaction: a migration with more than one statement puts them between `BEGIN;` and `COMMIT;` (with `PRAGMA foreign_keys` outside, where SQLite honours it), so that a failure leaves nothing half done.
