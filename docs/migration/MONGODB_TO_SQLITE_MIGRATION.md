# MongoDB to SQLite Migration Guide

This document describes the process of migrating the project's database from MongoDB to SQLite using Prisma ORM.

## 1. Overview

The database has been moved from MongoDB to SQLite to simplify deployment and reduce dependency on an external database server. We use **Prisma ORM** to manage the SQLite database.

## 2. Technical Changes

- **Database**: MongoDB -> SQLite (`voice-log.db`)
- **ORM**: Mongoose/MongoDB Driver -> Prisma
- **Schema**: Flattened the `voiceMessageTTS` embedded object into separate columns in the `ServerConfig` table.

## 3. How to Migrate Data (from MongoDB Dump)

If you have an existing MongoDB database and want to move the data to the new SQLite setup, follow these steps:

### Prerequisites

- Ensure you have the latest dependencies installed: `pnpm install`

### Execution Steps

1. **Generate Prisma Client**:

   ```bash
   pnpm db:generate
   ```

2. **Build the Project**:
   Build the project so that the `dist` folder is available:

   ```bash
   pnpm build:prod
   ```

3. **Migrate Config**:
   Run the bot once to migrate `config.json` to new version:

   ```bash
   node dist
   ```

   *The bot will exit immediately after backup and migrating config.*

4. **Prepare MongoDB Dump**:
   Export your MongoDB collection to a JSON file using `mongoexport`:

   ```bash
   mongoexport --uri="mongodb://your-mongo-uri" --collection=ServerConfig --out=mongo_dump.json
   ```

   *Note: If your MongoDB instance requires authentication, you must add the `--authenticationDatabase=admin` flag to the command.*

   For example, default config in previous version:

   ```bash
   mongoexport --uri="mongodb://localhost:27017/VoiceLog" --collection=serverConfig --out=mongo_dump.json
   ```

   Place the resulting `mongo_dump.json` file in the project root directory, `pnpm migrate --import-mongo` first copies it (and the database file, if one exists) to `backup/<YYYYMMDD-HHmmss>/`, and deletes it after importing. With `--yolo` no backup is made: keep a copy elsewhere.

5. **Run Data Migration**:
   Run `pnpm migrate --import-mongo`. It checks that the dump parses and that every field has the right type, creates the SQLite database (or applies pending migrations), imports every document of `mongo_dump.json` in one transaction, deletes the dump, and then upgrades the rest of the data. Before changing anything it backs up the dump, the database file and the old `assets/*.json` to `backup/<YYYYMMDD-HHmmss>/` (see [Backups](../../README.md#backups) for what is copied and how to restore); if the backup fails it exits with an error before changing anything, and `pnpm migrate --import-mongo --yolo` skips the backup:

   ```bash
   pnpm migrate --import-mongo
   ```

   Without `--import-mongo`, `pnpm migrate` never imports the dump. If the dump is invalid or the import fails, `pnpm migrate` exits with an error, nothing is imported and the dump stays where it is; fix the problem and run it again. Documents are upserted by `serverID`, so running it again with the same dump is safe. If only deleting the dump fails, the data is already imported: move the dump away yourself. The bot never imports the dump on its own: while the dump file is present, `pnpm start` logs an error asking you to run `pnpm migrate --import-mongo` (or move the file away) and exits with code 78.

   *Note: If your dump file has a different name or location, pass its path to `--import-mongo`, or set `MONGODB_DUMP_PATH` for both `pnpm migrate` and `pnpm start`:*

   ```bash
   pnpm migrate --import-mongo ./my_custom_dump.json
   MONGODB_DUMP_PATH="./my_custom_dump.json" pnpm migrate --import-mongo
   ```

6. **Verification**:
   Check that the `voice-log.db` file contains the migrated data using Prisma Studio, then start the bot with `pnpm start`:

   ```bash
   pnpm db:studio
   ```

## 4. Development Notes

- To view or edit data manually: `npx prisma studio`
- To update the schema:
  1. Modify `prisma/schema.prisma`
  2. Run `pnpm db:migrate`
  3. Run `pnpm db:generate`
