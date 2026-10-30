import { existsSync as exists, readdirSync as readDir, readFileSync as readFile } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ASSET_STEPS, ASSETS_DIR, assetConfigFiles, backupAssets } from '../Audio/AssetsMigration'
import type { MemberConfig } from '../Audio/Audio'
import { instances } from '../Utils/Instances'
import { writeAtomic } from '../Utils/WriteAtomic'
import { prisma } from './SQLite/Client'

// Version of the app-side data format (assets/<id>.json). The database is versioned by Prisma's
// migration history instead. Bump it only for a breaking change, at most once per PR, and add exactly
// one step for the bump to ASSET_STEPS.
export const DATA_VERSION = 2

// Exit code of the bot when it refuses to start until `pnpm migrate` is run (EX_CONFIG in sysexits.h).
// ecosystem.config.js lists it in stop_exit_codes so pm2 does not restart into the same error.
export const EXIT_NOT_MIGRATED = 78

const RECORD_FILE = 'data-version.json'
const MIGRATIONS_DIR = 'prisma/migrations'
const MIGRATE_HINT = '請先執行 `pnpm migrate`'

const logger = instances.mainLogger.getSubLogger({ name: 'DataMigration' })

type VersionRecord = { kind: 'none' } | { kind: 'ok'; version: number } | { kind: 'invalid'; reason: string }

// Run by `pnpm migrate` after `prisma migrate deploy`. Converts assets/<id>.json up to DATA_VERSION and
// records the version only when every file was converted; otherwise the record is left as it was, so
// running it again finishes the job. Returns false on failure.
export async function migrateData(): Promise<boolean> {
  const path = recordFilePath()
  const record = readUsableRecord(path, 'nothing was converted')
  if (!record) return false
  if (record.kind === 'ok' && record.version === DATA_VERSION) {
    logger.info(`Data is already at version ${DATA_VERSION}`)
    return true
  }

  const files = assetConfigFiles()
  if (record.kind === 'none' && files.length === 0) {
    await writeRecord(path, DATA_VERSION)
    logger.info(`Fresh install, data version ${DATA_VERSION} recorded in ${path}`)
    return true
  }

  // No record but existing assets/<id>.json: the install predates data versions, so version 1
  const from = record.kind === 'ok' ? record.version : 1
  logger.info(`Upgrading data from version ${from} to ${DATA_VERSION}`)
  const pending = planAssets(files, from)

  if (pending.length > 0) {
    try {
      logger.info(`Assets to convert backed up to ${await backupAssets(pending.map(({ file }) => file))}`)
    } catch (error) {
      logger.error('Assets backup failed; nothing was converted:', error)
      return false
    }
  }
  let failed = 0
  for (const { file, config } of pending) {
    try {
      await writeAtomic(`${ASSETS_DIR}/${file}`, `${JSON.stringify(config, null, 2)}\n`)
      logger.info(`Migrated ${ASSETS_DIR}/${file} to provider ${config.provider}`)
    } catch (error) {
      failed++
      logger.error(`Failed to migrate ${ASSETS_DIR}/${file}:`, error)
    }
  }
  if (failed > 0) {
    logger.error(`${failed} asset files could not be migrated; data version is still ${from}, run \`pnpm migrate\` again`)
    return false
  }

  await writeRecord(path, DATA_VERSION)
  logger.info(`Data version ${DATA_VERSION} recorded in ${path}`)
  return true
}

// Run at bot startup; only reads. Unless 'ok', the bot must not start and one error was logged:
// 'not-migrated' for unapplied Prisma migrations or a missing or older data version, 'unusable' for a
// malformed record or one newer than DATA_VERSION.
export async function checkData(): Promise<'ok' | 'not-migrated' | 'unusable'> {
  const path = recordFilePath()
  const record = readUsableRecord(path, 'refusing to start')
  if (!record) return 'unusable'

  const problems: string[] = []
  const pending = await pendingMigrations()
  if (pending.length > 0) problems.push(`unapplied database migrations: ${pending.join(', ')}`)
  if (record.kind === 'none') problems.push(`no data version recorded in ${path}`)
  else if (record.version < DATA_VERSION) problems.push(`data version ${record.version} is older than ${DATA_VERSION}`)
  if (problems.length === 0) return 'ok'

  logger.error(`Data is not up to date (${problems.join('; ')}). ${MIGRATE_HINT}`)
  return 'not-migrated'
}

// The record, or undefined (after logging an error ending in `outcome`) when it is malformed or newer
// than DATA_VERSION, which nothing in this build may act on
function readUsableRecord(path: string, outcome: string) {
  const record = readRecord(path)
  if (record.kind === 'invalid') {
    logger.error(`${record.reason}; ${outcome}`)
    return undefined
  }
  if (record.kind === 'ok' && record.version > DATA_VERSION) {
    logger.error(`${path} says data version ${record.version}, newer than this build (${DATA_VERSION}); ${outcome}. Downgrades are not supported`)
    return undefined
  }
  return record
}

// Runs the steps from `from` to DATA_VERSION on every file and returns the ones that changed.
// Unreadable files are logged and left alone.
function planAssets(files: string[], from: number) {
  const pending: { file: string; config: MemberConfig }[] = []
  for (const file of files) {
    const path = `${ASSETS_DIR}/${file}`
    let config: unknown
    try {
      config = JSON.parse(readFile(path, { encoding: 'utf-8' }))
    } catch (error) {
      logger.error(`Skipping ${path}: invalid JSON`, error)
      continue
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      logger.error(`Skipping ${path}: unsupported format (expected a JSON object)`)
      continue
    }
    let current = config as MemberConfig
    let changed = false
    for (let version = from; version < DATA_VERSION; version++) {
      const step = ASSET_STEPS[version]
      if (!step) throw new Error(`No assets migration step from data version ${version}`)
      const next = step(current)
      if (next) {
        current = next
        changed = true
      }
    }
    if (changed) pending.push({ file, config: current })
  }
  return pending
}

// The record lives next to the SQLite database file
function recordFilePath() {
  return resolve(dirname(databasePath()), RECORD_FILE)
}

function databasePath() {
  const url = instances.config.sqlite.databaseUrl
  if (!url.startsWith('file:')) throw new Error(`Unsupported database URL ${url}`)
  return resolve(url.slice('file:'.length).split('?')[0])
}

function readRecord(path: string): VersionRecord {
  if (!exists(path)) return { kind: 'none' }
  let version: unknown
  try {
    version = JSON.parse(readFile(path, { encoding: 'utf-8' }))?.version
  } catch {
    return { kind: 'invalid', reason: `${path} is not valid JSON` }
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'invalid', reason: `${path} has no valid "version" (expected a positive integer, got ${JSON.stringify(version)})` }
  }
  return { kind: 'ok', version }
}

async function writeRecord(path: string, version: number) {
  await writeAtomic(path, `${JSON.stringify({ version }, null, 2)}\n`)
}

// Migrations in prisma/migrations that the database has not finished applying. Never creates the
// database file.
async function pendingMigrations() {
  const all = readDir(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  if (!exists(databasePath())) return all
  const history = await prisma.$queryRawUnsafe<unknown[]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'")
  if (history.length === 0) return all
  const applied = await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
  const appliedNames = new Set(applied.map((row) => row.name))
  return all.filter((name) => !appliedNames.has(name))
}
