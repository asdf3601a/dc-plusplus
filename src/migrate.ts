// Entry point of `pnpm migrate`: parses the options and runs the migration (see Migration/index.ts).
// Running it from here, not from the package.json script, passes options such as --skip-invalid to
// every step.
import { MONGODB_DUMP_PATH, migrate } from './Migration'
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
  return migrate({ preflight: flags.has('--preflight'), skipInvalid: flags.has('--skip-invalid'), dumpPath })
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    instances.mainLogger.fatal('Data migration failed:', error)
    process.exit(1)
  })
