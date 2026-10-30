// Entry point of `pnpm migrate`: checks the data version record and the assets (preflight), applies the
// database migrations (`prisma migrate deploy`), imports a MongoDB dump with --import-mongo [path], then
// upgrades the app-side data. Running the steps from here, not from the package.json script, passes
// options such as --skip-invalid to all of them. With --preflight it stops after the check.
import { spawnSync } from 'node:child_process'
import { existsSync as exists } from 'node:fs'
import { MONGODB_DUMP_PATH, migrateData, preflightData } from './Core/DataMigration'
import { importMongoDump, preflightMongoDump } from './Core/SQLite/Migration'
import { instances } from './Utils/Instances'

const OPTIONS = ['--preflight', '--skip-invalid', '--import-mongo [path]']

async function run() {
  // `pnpm migrate -- --skip-invalid` passes the "--" through
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const flags = new Set<string>()
  const unknown: string[] = []
  let dumpPath: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--import-mongo') {
      dumpPath = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : MONGODB_DUMP_PATH
    } else if (arg === '--preflight' || arg === '--skip-invalid') {
      flags.add(arg)
    } else {
      unknown.push(arg)
    }
  }
  if (unknown.length > 0) {
    instances.mainLogger.error(`Unknown option ${unknown.join(', ')} (available: ${OPTIONS.join(', ')})`)
    return false
  }
  const skipInvalid = flags.has('--skip-invalid')
  if (!preflightData({ skipInvalid })) return false
  if (dumpPath !== undefined && !preflightMongoDump(dumpPath)) return false
  if (dumpPath === undefined && exists(MONGODB_DUMP_PATH)) {
    instances.mainLogger.warn(`MongoDB dump ${MONGODB_DUMP_PATH} is not imported without --import-mongo; the bot refuses to start while it is there`)
  }
  if (flags.has('--preflight')) return true
  if (!deployDatabaseMigrations()) return false
  if (dumpPath !== undefined && !(await importMongoDump(dumpPath))) return false
  return migrateData({ skipInvalid })
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
