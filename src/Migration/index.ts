import { spawnSync } from 'node:child_process'
import { existsSync as exists, readdirSync as readDir, readFileSync as readFile } from 'node:fs'
import { resolve } from 'node:path'
import { instances } from '../Utils/Instances'
import { writeAtomic } from '../Utils/WriteAtomic'
import { ASSET_STEPS, ASSETS_DIR, assetConfigFiles } from './assets/steps'
import { BACKUP_DIR, backup, RestoreError, restore } from './backup'
import { importMongoDump, preflightMongoDump } from './import-mongo'
import { databasePath, readRecord, recordFilePath, writeRecord } from './record'
import { databaseLock, failedMigrations } from './sqlite'

// Version of the app-side data format (assets/<id>.json). The database is versioned by Prisma's
// migration history instead. Bump it only for a breaking change, at most once per PR, and add exactly
// one step for the bump to ASSET_STEPS.
export const DATA_VERSION = 2

// Exit code of the bot when the startup data check fails: not migrated yet, or a malformed or newer
// data version record (EX_CONFIG in sysexits.h). ecosystem.config.js lists it in stop_exit_codes so
// pm2 does not restart into the same error.
export const EXIT_DATA_CHECK_FAILED = 78

// Default MongoDB export to import into SQLite with `pnpm migrate --import-mongo`, which deletes it
// afterwards; the bot refuses to start while it exists
export const MONGODB_DUMP_PATH = process.env.MONGODB_DUMP_PATH ?? './mongo_dump.json'

const MIGRATIONS_DIR = 'prisma/migrations'
const MIGRATE_HINT = '請先執行 `pnpm migrate`'

const logger = instances.mainLogger.getSubLogger({ name: 'DataMigration' })

// What a `pnpm migrate` run has done so far, for the message on a failure
type RunState = { yolo: boolean; backupDir?: string }

// `pnpm migrate`: checks the data version record and the assets (preflight), waits until no other
// connection holds the database locked, backs up what it will change (unless yolo) to a new directory in
// backupDir, applies the database migrations (`prisma migrate deploy`), imports the MongoDB dump at
// dumpPath if given, then upgrades the app-side data. With preflight it stops after the check, having only
// read. Returns false on failure, after saying what was changed and how to restore the backup.
export async function migrate({
  preflight = false,
  skipInvalid = false,
  yolo = false,
  dumpPath,
  backupDir = BACKUP_DIR
}: {
  preflight?: boolean
  skipInvalid?: boolean
  yolo?: boolean
  dumpPath?: string
  backupDir?: string
}) {
  if (!preflightData({ skipInvalid })) return false
  if (dumpPath !== undefined && !preflightMongoDump(dumpPath)) return false
  if (dumpPath === undefined && exists(MONGODB_DUMP_PATH)) {
    instances.mainLogger.warn(`MongoDB dump ${MONGODB_DUMP_PATH} is not imported without --import-mongo; the bot refuses to start while it is there`)
  }
  if (preflight) return true
  if (!(await databaseUnlocked('nothing was changed'))) return false
  const run: RunState = { yolo }
  if (!(await backupData({ yolo, dumpPath, backupDir, run }))) return false
  if (!deployDatabaseMigrations()) return failed(run)
  if (dumpPath !== undefined && !(await importMongoDump(dumpPath))) {
    logger.error('The database migrations of this run were applied; assets/*.json and data-version.json were not changed')
    return failed(run)
  }
  return (await migrateData({ skipInvalid })) || failed(run)
}

// Logs how to undo a run that failed after it started changing data; returns false
function failed({ yolo, backupDir }: RunState) {
  if (backupDir !== undefined) logger.error(`To undo this run, stop the bot and run \`pnpm migrate --restore ${backupDir}\` (the backup made before it changed anything)`)
  else if (yolo) logger.error('No backup was made (--yolo); restore your own backup to undo this run')
  else logger.error('No backup was made: this run found no existing data to change')
  return false
}

// `pnpm migrate --restore <dir>`: puts the data in the backup at dir back (see restore in backup.ts),
// after backing up the data it replaces to a new directory in backupDir. Does not migrate. Returns false,
// after saying what was changed, on failure.
export async function restoreBackup({ dir, backupDir = BACKUP_DIR }: { dir: string; backupDir?: string }) {
  if (!(await databaseUnlocked('nothing was restored'))) return false
  try {
    const { manifest, replaced } = await restore(dir, { baseDir: backupDir, dataVersion: currentDataVersion() })
    logger.info(`Restored ${dir} (made ${manifest.createdAt} by version ${manifest.appVersion}, data version ${manifest.dataVersion ?? 'none'})`)
    logger.info(`The data from before the restore is in ${replaced}; run \`pnpm migrate --restore ${replaced}\` to go back to it`)
    logger.info('Nothing was migrated: run `pnpm migrate` to upgrade the restored data (the bot refuses to start until then), or run the version of the bot that matches it')
    return true
  } catch (error) {
    if (error instanceof RestoreError) logger.error(error.message)
    else logger.error(`Restoring ${dir} failed:`, error)
    return false
  }
}

function currentDataVersion() {
  const record = readRecord(recordFilePath())
  return record.kind === 'ok' ? record.version : null
}

// Waits a few seconds for another connection to release the database; if it does not, logs what holds
// it (ending in outcome) and returns false. True when there is no database yet.
async function databaseUnlocked(outcome: string) {
  const path = databasePath()
  if (!exists(path)) return true
  const holder = await databaseLock(path, (attempt, tries, waitMs) => {
    logger.warn(`The database ${path} is locked; trying again in ${waitMs / 1000} s (${attempt}/${tries})`)
  })
  if (holder === undefined) return true
  logger.error(`The database ${path} is still locked: ${holder}; ${outcome}. Close that connection and run it again`)
  return false
}

// Run by `pnpm migrate` after the preflight, before anything is changed. Unless yolo (then it only warns),
// backs up all the data: the database, every file in assets/, the record and the MongoDB dump (the one
// given to --import-mongo, deleted after the import, or else the default one if it is there), whatever
// this run changes. Makes no backup when none of
// them exists yet (a fresh install). Returns false, having changed nothing, when the backup fails.
async function backupData({ yolo, dumpPath, backupDir, run }: { yolo: boolean; dumpPath?: string; backupDir: string; run: RunState }) {
  if (yolo) {
    logger.warn('--yolo: no backup was made')
    return true
  }
  const database = databasePath()
  // Without --import-mongo the default dump is kept only if it is there, so restoring never deletes one
  // that was put in place later
  const dump = dumpPath ?? (exists(MONGODB_DUMP_PATH) ? MONGODB_DUMP_PATH : undefined)
  const files = [recordFilePath(), ...(dump !== undefined ? [dump] : [])]
  if (!exists(database) && !exists(ASSETS_DIR) && !files.some((file) => exists(file))) return true
  // preflightData already rejected a malformed or newer record
  const record = readRecord(recordFilePath())
  try {
    // A path that does not exist (no database or record yet) is recorded as absent, so restoring
    // deletes the one this run creates
    run.backupDir = await backup({ database, dirs: [ASSETS_DIR], files, baseDir: backupDir, reason: 'migrate', dataVersion: record.kind === 'ok' ? record.version : null })
    logger.info(`Backed up to ${resolve(run.backupDir)}; to undo this run, stop the bot and run \`pnpm migrate --restore ${run.backupDir}\``)
    return true
  } catch (error) {
    logger.error('Backup failed; nothing was changed. Fix the problem and run `pnpm migrate` again, or run `pnpm migrate --yolo` to migrate without a backup:', error)
    return false
  }
}

// The Prisma CLI of this install, run with this node so it needs no shell or PATH entry. On a failure,
// logs what state it left the database in.
function deployDatabaseMigrations() {
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { stdio: 'inherit' })
  if (result.status === 0) return true
  logger.error(
    `prisma migrate deploy failed (${result.error ?? `exit ${result.status ?? result.signal}`}); ${databaseStateAfterFailure()}; assets/*.json and data-version.json were not changed`
  )
  return false
}

// What a failed `prisma migrate deploy` left: the migration Prisma recorded as failed, and whether its
// SQL runs in a transaction (BEGIN ... COMMIT), so that its changes were rolled back
function databaseStateAfterFailure() {
  let failedNames: string[]
  try {
    failedNames = failedMigrations(databasePath())
  } catch (error) {
    return `the state of the database is unknown (${error instanceof Error ? error.message : error})`
  }
  if (failedNames.length === 0) return 'no migration was recorded as failed, so Prisma stopped before changing the database'
  const states = failedNames.map((name) => {
    const file = `${MIGRATIONS_DIR}/${name}/migration.sql`
    const sql = exists(file) ? readFile(file, { encoding: 'utf-8' }) : ''
    const transactional = /^BEGIN( TRANSACTION)?;/m.test(sql) && /^COMMIT;/m.test(sql)
    return transactional
      ? `migration ${name} failed and its changes were rolled back (it runs in a transaction)`
      : `migration ${name} failed and does not run in a transaction, so the database may be partly changed`
  })
  const resolveHint = failedNames.map((name) => `\`pnpm prisma migrate resolve --rolled-back ${name}\``).join(', ')
  return `${states.join('; ')}; migrations before it stay applied. Prisma refuses to deploy again until you restore the backup, or fix the problem and run ${resolveHint}`
}

// Run by `pnpm migrate` after `prisma migrate deploy`. Converts assets/<id>.json up to DATA_VERSION and
// records the version only when every file was converted; otherwise the record is left as it was, so
// running it again finishes the job. An asset file that is not a JSON object fails the run before
// anything is converted, unless skipInvalid leaves such files as they are. Returns false on failure.
async function migrateData({ skipInvalid = false } = {}): Promise<boolean> {
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
  const { pending, invalid } = planAssets(files, from, skipInvalid)
  if (invalid.length > 0 && !skipInvalid) {
    logInvalidAssets(invalid, `nothing was converted and data version is still ${from}`)
    return false
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

// Run at bot startup; only reads. Returns false (after logging one error) when the bot must not start:
// unapplied Prisma migrations, a missing or older data version, a MongoDB dump not imported yet, or a
// malformed or newer record.
export async function checkData(): Promise<boolean> {
  const path = recordFilePath()
  const record = readUsableRecord(path, 'refusing to start')
  if (!record) return false

  const problems: string[] = []
  const pending = await pendingMigrations()
  if (pending.length > 0) problems.push(`unapplied database migrations: ${pending.join(', ')}`)
  if (record.kind === 'none') problems.push(`no data version recorded in ${path}`)
  else if (record.version < DATA_VERSION) problems.push(`data version ${record.version} is older than ${DATA_VERSION}`)
  const dump = exists(MONGODB_DUMP_PATH)
  if (dump) problems.push(`MongoDB dump ${MONGODB_DUMP_PATH} not imported yet`)
  if (problems.length === 0) return true

  const hint = dump ? `請先執行 \`pnpm migrate --import-mongo\`，或將 ${MONGODB_DUMP_PATH} 移走` : MIGRATE_HINT
  logger.error(`Data is not up to date (${problems.join('; ')}). ${hint}`)
  return false
}

// Run by `pnpm migrate` before `prisma migrate deploy`, so a malformed record, one newer than
// DATA_VERSION, or (unless skipInvalid) an invalid asset file that migrateData would reject stops it
// before the database is touched. Only reads.
function preflightData({ skipInvalid = false } = {}): boolean {
  const record = readUsableRecord(recordFilePath(), 'nothing was changed')
  if (!record) return false
  if (skipInvalid || (record.kind === 'ok' && record.version === DATA_VERSION)) return true
  const { invalid } = planAssets(assetConfigFiles(), record.kind === 'ok' ? record.version : 1, false)
  if (invalid.length === 0) return true
  logInvalidAssets(invalid, 'nothing was changed (the database was not migrated)')
  return false
}

function logInvalidAssets(invalid: string[], outcome: string) {
  logger.error(
    `${invalid.length} asset files are not valid: ${invalid.join(', ')}; ${outcome}. Fix or remove them and run \`pnpm migrate\` again, or run \`pnpm migrate --skip-invalid\` to leave them unconverted`
  )
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

// Runs the steps from `from` to DATA_VERSION on every file and returns the ones that changed, and the
// paths of files that are not a JSON object (each logged, never converted).
function planAssets(files: string[], from: number, skipInvalid: boolean) {
  const pending: { file: string; config: Record<string, unknown> }[] = []
  const invalid: string[] = []
  const label = skipInvalid ? 'Skipping' : 'Invalid'
  for (const file of files) {
    const path = `${ASSETS_DIR}/${file}`
    let config: unknown
    try {
      config = JSON.parse(readFile(path, { encoding: 'utf-8' }))
    } catch (error) {
      logger.error(`${label} ${path}: invalid JSON`, error)
      invalid.push(path)
      continue
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      logger.error(`${label} ${path}: unsupported format (expected a JSON object)`)
      invalid.push(path)
      continue
    }
    let current = config as Record<string, unknown>
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
  return { pending, invalid }
}

// Migrations in prisma/migrations that the database has not finished applying. Never creates the
// database file.
async function pendingMigrations() {
  const all = readDir(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  if (!exists(databasePath())) return all
  // Loaded here: importing the client creates the database directory, which --preflight must not do
  const { prisma } = await import('../Core/SQLite/Client')
  const history = await prisma.$queryRawUnsafe<unknown[]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'")
  if (history.length === 0) return all
  const applied = await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
  const appliedNames = new Set(applied.map((row) => row.name))
  return all.filter((name) => !appliedNames.has(name))
}
