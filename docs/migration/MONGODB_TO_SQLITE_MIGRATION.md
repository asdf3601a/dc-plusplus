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

   Place the resulting `mongo_dump.json` file in the project root directory.

5. **Run Data Migration**:
   Run `pnpm migrate`. It creates the SQLite database (or applies pending migrations), imports every document of `mongo_dump.json` into it, deletes the dump once the import succeeded, and then upgrades the rest of the data:

   ```bash
   pnpm migrate
   ```

   If the import fails, `pnpm migrate` exits with an error and the dump is kept; fix the problem and run it again (documents are upserted by `serverID`). The bot never imports the dump on its own: while the dump file is present, `pnpm start` logs an error asking you to run `pnpm migrate` and exits with code 78.

   *Note: If your dump file has a different name or location, pass the path via an environment variable, to both `pnpm migrate` and `pnpm start`:*

   ```bash
   MONGODB_DUMP_PATH="./my_custom_dump.json" pnpm migrate
   MONGODB_DUMP_PATH="./my_custom_dump.json" pnpm start
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
