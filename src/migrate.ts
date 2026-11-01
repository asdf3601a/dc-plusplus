// Entry point of `pnpm migrate`: parses the options and runs the migration (see Migration/index.ts), or
// with --restore puts a backup back. Running it from here, not from the package.json script, passes
// options such as --skip-invalid to every step.

type Option = { flag: string; alias?: string; arg?: '<path>'; help: string; notWithRestore?: boolean }

// The only list of options: the parser, the error messages, --help and the check against --restore
// (which only puts a backup back) all come from it. docs/UPGRADING.md#options repeats the help lines.
const OPTIONS: readonly Option[] = [
  { flag: '--help', alias: '-h', help: 'Print this help and exit, changing nothing; wins over every other option' },
  { flag: '--preflight', help: 'Only check the data version record, the assets and the MongoDB dump, then stop; changes nothing and makes no backup', notWithRestore: true },
  { flag: '--skip-invalid', help: 'Leave asset files that are not a JSON object unconverted instead of failing the run', notWithRestore: true },
  { flag: '--yolo', help: 'Migrate without making a backup first; back up yourself', notWithRestore: true },
  { flag: '--backup-dir', arg: '<path>', help: 'Make the backup in <path>/<YYYYMMDD-HHmmss-SSS>/ instead of backup/' },
  { flag: '--restore', arg: '<path>', help: 'Put the backup in <path> back, after backing up the current data; does not migrate' },
  { flag: '--mongo-dump', arg: '<path>', help: 'Import the MongoDB dump at <path> instead of ./mongo_dump.json; the path must exist', notWithRestore: true }
]

const usage = ({ flag, alias, arg }: Option) => [alias, flag].filter(Boolean).join(', ') + (arg ? ` ${arg}` : '')

function help() {
  const width = Math.max(...OPTIONS.map((option) => usage(option).length))
  const lines = OPTIONS.map((option) => `  ${usage(option).padEnd(width)}  ${option.help}`)
  return ['Usage: pnpm migrate [options]', '', 'Options:', ...lines, ''].join('\n')
}

async function run() {
  // `pnpm migrate -- --skip-invalid` passes the "--" through
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const problems: string[] = []
  const value = (i: number) => (args[i + 1] !== undefined && !args[i + 1].startsWith('-') ? args[i + 1] : undefined)
  for (let i = 0; i < args.length; i++) {
    const option = OPTIONS.find(({ flag, alias }) => args[i] === flag || args[i] === alias)
    if (option === undefined) {
      problems.push(`Unknown option ${args[i]}`)
      continue
    }
    flags.add(option.flag)
    if (option.arg === undefined) continue
    const path = value(i)
    if (path === undefined) problems.push(`${option.flag} needs a path`)
    else {
      values.set(option.flag, path)
      i++
    }
  }
  if (flags.has('--help')) {
    process.stdout.write(help())
    return true
  }
  if (flags.has('--restore')) {
    const conflicting = OPTIONS.filter((option) => option.notWithRestore && flags.has(option.flag)).map((option) => option.flag)
    if (conflicting.length > 0) problems.push(`--restore cannot be used with ${conflicting.join(', ')}`)
  }
  if (flags.has('--yolo') && flags.has('--backup-dir')) problems.push('--yolo makes no backup, so it cannot be used with --backup-dir')

  // Loaded only now: loading the config rewrites config.json, or creates it and exits, which --help must not do
  const { instances } = await import('./Utils/Instances')
  if (problems.length > 0) {
    instances.mainLogger.error(`${problems.join('; ')} (available: ${OPTIONS.map(usage).join(', ')}; see \`pnpm migrate --help\`); nothing was changed`)
    return false
  }
  const { migrate, restoreBackup, warnRemovedDumpEnv } = await import('./Migration')
  const backupDir = values.get('--backup-dir')
  const restoreDir = values.get('--restore')
  if (restoreDir !== undefined) return restoreBackup({ dir: restoreDir, backupDir })
  warnRemovedDumpEnv()
  return migrate({ preflight: flags.has('--preflight'), skipInvalid: flags.has('--skip-invalid'), yolo: flags.has('--yolo'), backupDir, mongoDump: values.get('--mongo-dump') })
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch(async (error) => {
    const { instances } = await import('./Utils/Instances')
    instances.mainLogger.fatal('Data migration failed:', error)
    process.exit(1)
  })
