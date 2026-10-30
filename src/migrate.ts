// Entry point of `pnpm migrate`: checks the data version record and the assets (preflight), applies the
// database migrations (`prisma migrate deploy`), imports a MongoDB dump if there is one, then upgrades
// the app-side data. Running the steps from here, not from the package.json script, passes options such
// as --skip-invalid to all of them. With --preflight it stops after the check.
import { spawnSync } from 'node:child_process'
import { existsSync as exists } from 'node:fs'
import { MONGODB_DUMP_PATH, migrateData, preflightData } from './Core/DataMigration'
import { instances } from './Utils/Instances'

const OPTIONS = ['--preflight', '--skip-invalid']

async function run() {
  // `pnpm migrate -- --skip-invalid` passes the "--" through
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const unknown = args.filter((arg) => !OPTIONS.includes(arg))
  if (unknown.length > 0) {
    instances.mainLogger.error(`Unknown option ${unknown.join(', ')} (available: ${OPTIONS.join(', ')})`)
    return false
  }
  const skipInvalid = args.includes('--skip-invalid')
  if (!preflightData({ skipInvalid })) return false
  if (args.includes('--preflight')) return true
  if (!deployDatabaseMigrations()) return false
  if (!(await importMongoDump())) return false
  return migrateData({ skipInvalid })
}

// Upserts every document of the dump into SQLite and deletes the dump on success
async function importMongoDump() {
  if (!exists(MONGODB_DUMP_PATH)) return true
  // Loaded here: importing it creates the database directory, which --preflight must not do
  const { migrateMongoToSqlite } = await import('./Core/SQLite/Migration')
  try {
    await migrateMongoToSqlite(MONGODB_DUMP_PATH)
    return true
  } catch {
    // migrateMongoToSqlite logged the error
    return false
  }
}

// The Prisma CLI of this install, run with this node so it needs no shell or PATH entry
function deployDatabaseMigrations() {
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { stdio: 'inherit' })
  if (result.status === 0) return true
  instances.mainLogger.error(`prisma migrate deploy failed (${result.error ?? `exit ${result.status ?? result.signal}`}); the data was not upgraded`)
  return false
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    instances.mainLogger.fatal('Data migration failed:', error)
    process.exit(1)
  })
