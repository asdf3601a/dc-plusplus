// Entry point of `pnpm migrate`: parses the options and runs the migration (see Migration/index.ts), or
// with --restore puts a backup back. Running it from here, not from the package.json script, passes
// options such as --skip-invalid to every step.
import { migrate, restoreBackup } from './Migration'
import { instances } from './Utils/Instances'

const OPTIONS = ['--preflight', '--skip-invalid', '--yolo', '--backup-dir <path>', '--restore <path>', '--mongo-dump <path>']
// Options that make no sense with --restore, which only puts a backup back
const NOT_WITH_RESTORE = ['--preflight', '--skip-invalid', '--yolo', '--mongo-dump']

async function run() {
  // `pnpm migrate -- --skip-invalid` passes the "--" through
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const flags = new Set<string>()
  const problems: string[] = []
  let backupDir: string | undefined
  let restoreDir: string | undefined
  let mongoDump: string | undefined
  const value = (i: number) => (args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--backup-dir' || arg === '--restore' || arg === '--mongo-dump') {
      const path = value(i)
      if (path === undefined) problems.push(`${arg} needs a path`)
      else i++
      if (arg === '--backup-dir') backupDir = path
      else if (arg === '--restore') restoreDir = path
      else mongoDump = path
      flags.add(arg)
    } else if (arg === '--preflight' || arg === '--skip-invalid' || arg === '--yolo') {
      flags.add(arg)
    } else {
      problems.push(`Unknown option ${arg}`)
    }
  }
  if (flags.has('--restore')) {
    const conflicting = NOT_WITH_RESTORE.filter((flag) => flags.has(flag))
    if (conflicting.length > 0) problems.push(`--restore cannot be used with ${conflicting.join(', ')}`)
  }
  if (flags.has('--yolo') && flags.has('--backup-dir')) problems.push('--yolo makes no backup, so it cannot be used with --backup-dir')
  if (problems.length > 0) {
    instances.mainLogger.error(`${problems.join('; ')} (available: ${OPTIONS.join(', ')}); nothing was changed`)
    return false
  }
  if (restoreDir !== undefined) return restoreBackup({ dir: restoreDir, backupDir })
  return migrate({ preflight: flags.has('--preflight'), skipInvalid: flags.has('--skip-invalid'), yolo: flags.has('--yolo'), backupDir, mongoDump })
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    instances.mainLogger.fatal('Data migration failed:', error)
    process.exit(1)
  })
