# Database Migration: MongoDB $\rightarrow$ SQLite (Prisma ORM)

This document records the complete transition of the project's database layer from MongoDB to SQLite using Prisma ORM.

## 1. Motivation

The migration was implemented to:

- **Simplify Deployment**: Remove the requirement for a running MongoDB server.
- **Improve Performance**: Local SQLite storage reduces network latency for configuration reads.
- **Enhance Type Safety**: Leverage Prisma's auto-generated TypeScript types.
- **Native Node.js usage**: Utilize SQLite's lightweight nature without external dependencies.

## 2. Architectural Changes

### Data Model Mapping

Since SQLite is a relational database, we flattened the MongoDB document structure:

| MongoDB Field | SQLite Column (Prisma) | Type | Note |
| :--- | :--- | :--- | :--- |
| `_id` | `serverID` | `String` | Primary Key |
| `lang` | `lang` | `String` | Default: `en_US` |
| `channelID` | `channelID` | `String` | Default: `""` |
| $\dots$ | $\dots$ | $\dots$ | $\dots$ |
| `voiceMessageTTS` | `ttsEnabled`, `ttsType`, etc. | Mixed | Flattened nested object |

### Implementation Details

- **Prisma Client**: Implemented as a singleton in `src/Core/SQLite/Client.ts`, using `@prisma/adapter-better-sqlite3` driver adapter (Prisma v7 requirement).
- **Compatibility Layer**: The `DbServerConfigManager` in `src/Core/SQLite/Core.ts` implements the same public API as the original MongoDB manager, ensuring zero breaks in business logic.
- **Configuration**: Database connection settings (e.g., `databaseUrl`) are managed via the `sqlite` section in `config.json`. Prisma CLI configuration is handled by `prisma.config.ts` at the project root.
- **Initialization**: Removed asynchronous event-based connection (`.once('connect')`) in favor of synchronous Prisma client initialization.

## 3. Files Added/Modified

### 📁 New Files

- `prisma/schema.prisma`: The source of truth for the database schema.
- `prisma.config.ts`: Prisma CLI configuration (reads `databaseUrl` from `config.json`).
- `src/Core/SQLite/Client.ts`: Prisma client instance with `@prisma/adapter-better-sqlite3`.
- `src/Core/SQLite/Core.ts`: SQLite implementation of the database manager.
- `src/Migration/import-mongo.ts` (originally `src/Core/SQLite/Migration.ts`): Logic for migrating data from MongoDB dumps to SQLite.
- `src/Core/SQLite/db/ServerConfig.ts`: Type definitions for the server configuration.

### 📁 Modified Files

- `src/index.ts`: Updated bot boot sequence and shutdown logic.
- `src/Utils/Config.ts`: Added SQLite configuration support.
- `src/Utils/Instances.ts`: Renamed `mongoDB` $\rightarrow$ `db`.
- `src/Core/Discord/VoiceLog/...`: Updated all imports to use the new SQLite core.

### 🗑️ Deleted

- `src/Core/MongoDB/`: Fully removed.
- `scripts/prisma-wrapper.js`: Removed in Prisma v7; replaced by `prisma.config.ts`.

## 4. Prisma v7 Upgrade

In July 2026, ORM was upgraded from Prisma v6 to v7. The key changes:

### Driver Adapter

Prisma v7 removed the built-in SQLite WASM engine. A driver adapter is now required. We use `@prisma/adapter-better-sqlite3` (only 5 npm packages total including a single prebuilt native addon) — the lightest pure-SQLite path available.

### Configuration

`prisma.config.ts` replaces the old `url = env("DATABASE_URL")` in `schema.prisma`. It reads the SQLite path from `config.json` at runtime, with a fallback to `file:./prisma/voice-log.db`.

### Client Initialization

`src/Core/SQLite/Client.ts` now instantiates the adapter:

```ts
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const adapter = new PrismaBetterSqlite3({
  url: instances.config.sqlite.databaseUrl,
})
export const prisma = new PrismaClient({ adapter })
```

### Removed

- `scripts/prisma-wrapper.js` — no longer needed; `prisma.config.ts` handles all CLI configuration
- `datasources` constructor option — removed in v7; use adapter instead
- `url = env("DATABASE_URL")` in `schema.prisma` — removed; managed by `prisma.config.ts`

### Scripts

All `db:*` scripts now call `prisma` directly instead of through the wrapper:

```json
"db:generate": "prisma generate",
"db:migrate": "prisma migrate dev",
"db:migrate:prod": "prisma migrate deploy",
"db:studio": "prisma studio"
```

### Dependencies

```bash
pnpm add prisma@^7 @prisma/client@^7 @prisma/adapter-better-sqlite3
```

## 5. Maintenance Guide

### Schema Updates

If you need to add fields to the database:

1. Edit `prisma/schema.prisma`.
2. Run `pnpm db:migrate`.
3. Run `pnpm db:generate`.

### Data Inspection

Use Prisma Studio for a GUI view of the data:

```bash
npx prisma studio
```

## 5. Migration Path (Existing Users)

Users with existing MongoDB data can migrate by providing a JSON dump:

1. Export MongoDB data to a JSON file (e.g., `mongo_dump.json`).
2. Place the dump file in the project root.
3. Start the bot; the migration will be performed automatically during the boot sequence.
   *Note: Custom dump paths can be specified by passing the `MONGODB_DUMP_PATH` environment variable during launch.*
