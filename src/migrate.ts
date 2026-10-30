// Entry point of `pnpm migrate`. With --preflight (run before `prisma migrate deploy`) it only checks
// the data version record; without it (run after) it upgrades the app-side data.
import { migrateData, preflightData } from './Core/DataMigration'
import { instances } from './Utils/Instances'

const OPTIONS = ['--preflight']

async function run() {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg) => !OPTIONS.includes(arg))
  if (unknown.length > 0) {
    instances.mainLogger.error(`Unknown option ${unknown.join(', ')} (available: ${OPTIONS.join(', ')})`)
    return false
  }
  if (args.includes('--preflight')) return preflightData()
  return migrateData()
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    instances.mainLogger.fatal('Data migration failed:', error)
    process.exit(1)
  })
