// Backups made by `pnpm migrate` and restored by `pnpm migrate --restore <dir>`. A backup is a directory
// holding copies of the files at the paths they had (relative to the working directory; files outside it
// under external/) and a manifest.json listing each one with its original path and sha256, the paths
// that did not exist then, which a restore deletes, and the directories backed up whole, in which a
// restore deletes the files the backup does not have.
import { createHash } from 'node:crypto'
import {
  constants,
  existsSync as exists,
  mkdirSync as mkDir,
  readdirSync as readDir,
  readFileSync as readFile,
  renameSync as rename,
  rmSync as rm,
  writeFileSync as writeFile
} from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { integrityProblems, vacuumInto } from './sqlite'

export const BACKUP_DIR = 'backup'
export const MANIFEST_FILE = 'manifest.json'
const MANIFEST_FORMAT = 1
const EXTERNAL_DIR = 'external'
// backup/<timestamp>-<n> when the timestamp is taken
const MAX_SUFFIX = 99

// kind "database": an SQLite file, checked with PRAGMA integrity_check; "file": any other file;
// "absent": nothing was at original, so a restore deletes what is there now
export type BackupEntry = { kind: 'database' | 'file'; original: string; file: string; sha256: string } | { kind: 'absent'; original: string }

export type Manifest = {
  format: typeof MANIFEST_FORMAT
  createdAt: string
  // "migrate": made by `pnpm migrate` before it changed anything; "restore": the data `--restore` replaced
  reason: 'migrate' | 'restore'
  appVersion: string
  // data-version.json at the time, null when there was none
  dataVersion: number | null
  // Directories backed up whole (every file in them is an entry)
  dirs: string[]
  entries: BackupEntry[]
}

// Thrown by restore with a message that says what was and was not changed
export class RestoreError extends Error {}

// YYYYMMDD-HHmmss-SSS in local time
function backupTimestamp(date = new Date()) {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
}

// Whether path is dir itself or somewhere under it
function isInside(path: string, dir: string) {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

// A new, empty <baseDir>/<timestamp>[-n]; never reuses an existing directory
function createBackupDir(baseDir: string) {
  mkDir(baseDir, { recursive: true })
  const name = backupTimestamp()
  for (let n = 0; n <= MAX_SUFFIX; n++) {
    const dir = join(baseDir, n === 0 ? name : `${name}-${n}`)
    try {
      // Not recursive: fails if the directory exists
      mkDir(dir)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`${join(baseDir, name)} and its -1 to -${MAX_SUFFIX} all exist`)
}

// How the manifest names a path: relative to the working directory (with /) when inside it, else absolute
function originalPath(path: string) {
  const rel = relative(process.cwd(), resolve(path))
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? resolve(path) : rel.split(sep).join('/')
}

// Where a backup keeps the copy of path: the same relative path, or external/<n>-<name> for one outside
// the working directory
function storedPath(original: string, index: number) {
  return isAbsolute(original) ? `${EXTERNAL_DIR}/${index}-${basename(original)}` : original
}

// A manifest's stored file path, if it stays inside the backup directory
function safeStoredPath(file: unknown) {
  if (typeof file !== 'string' || file === '' || isAbsolute(file)) return undefined
  const path = normalize(file)
  return path.startsWith('..') ? undefined : path
}

// Every file in dir and its subdirectories, as paths starting with dir; none when dir does not exist
function filesIn(dir: string): string[] {
  if (!exists(dir)) return []
  return readDir(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

function sha256(path: string) {
  return createHash('sha256').update(readFile(path)).digest('hex')
}

function appVersion() {
  try {
    return String(JSON.parse(readFile(resolve(__dirname, '../../package.json'), { encoding: 'utf-8' })).version)
  } catch {
    return 'unknown'
  }
}

// Backs up into a new <baseDir>/<YYYYMMDD-HHmmss-SSS>[-n]/ and returns that directory: the database
// (with rawDatabase a plain copy of the file and its -wal, else VACUUM INTO, a consistent copy even
// while the bot is running), every file in dirs and the files; a path that does not exist is recorded
// as absent. Then
// writes manifest.json and checks the backup as restore would. Throws if anything fails, after removing
// the unfinished backup; never overwrites one.
export async function backup({
  database,
  rawDatabase = false,
  dirs = [],
  files,
  baseDir = BACKUP_DIR,
  reason,
  dataVersion
}: {
  database?: string
  rawDatabase?: boolean
  dirs?: string[]
  files: string[]
  baseDir?: string
  reason: Manifest['reason']
  dataVersion: number | null
}) {
  const holder = dirs.find((path) => isInside(baseDir, path))
  if (holder !== undefined) throw new Error(`the backup directory ${baseDir} is inside ${holder}, which is backed up and restored whole; choose one outside it`)
  const dir = createBackupDir(baseDir)
  try {
    const entries: BackupEntry[] = []
    const copy = async (path: string, kind: 'database' | 'file') => {
      const original = originalPath(path)
      if (!exists(path)) {
        entries.push({ kind: 'absent', original })
        return
      }
      const file = storedPath(original, entries.length)
      const dest = join(dir, file)
      mkDir(dirname(dest), { recursive: true })
      if (kind === 'database' && !rawDatabase) vacuumInto(path, resolve(dest))
      else await copyFile(path, dest, constants.COPYFILE_EXCL)
      entries.push({ kind, original, file, sha256: sha256(dest) })
    }
    if (database !== undefined) {
      await copy(database, 'database')
      // A VACUUM INTO copy has everything in the main file; a restore deletes the -wal and -shm there
      if (rawDatabase) await copy(`${database}-wal`, 'file')
      else entries.push({ kind: 'absent', original: originalPath(`${database}-wal`) })
      entries.push({ kind: 'absent', original: originalPath(`${database}-shm`) })
    }
    for (const path of dirs) for (const file of filesIn(path)) await copy(file, 'file')
    for (const file of files) await copy(file, 'file')
    const manifest: Manifest = {
      format: MANIFEST_FORMAT,
      createdAt: new Date().toISOString(),
      reason,
      appVersion: appVersion(),
      dataVersion,
      dirs: dirs.map(originalPath),
      entries
    }
    writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    const { problems } = readBackup(dir)
    if (problems.length > 0) throw new Error(`the backup in ${dir} does not check out: ${problems.join('; ')}`)
  } catch (error) {
    rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

// Reads <dir>/manifest.json and checks every file in it against its sha256, and each database with
// PRAGMA integrity_check. Only reads. Returns the manifest (undefined if unreadable) and the problems.
export function readBackup(dir: string): { manifest?: Manifest; problems: string[] } {
  const manifestPath = join(dir, MANIFEST_FILE)
  if (!exists(manifestPath)) return { problems: [`${manifestPath} not found`] }
  let manifest: Manifest
  try {
    manifest = JSON.parse(readFile(manifestPath, { encoding: 'utf-8' }))
  } catch {
    return { problems: [`${manifestPath} is not valid JSON`] }
  }
  if (
    manifest?.format !== MANIFEST_FORMAT ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.dirs) ||
    !manifest.dirs.every((dir) => typeof dir === 'string' && dir !== '')
  ) {
    return { problems: [`${manifestPath} is not a backup manifest of format ${MANIFEST_FORMAT}`] }
  }
  const problems: string[] = []
  const originals = new Set<string>()
  for (const entry of manifest.entries) {
    if (typeof entry?.original !== 'string' || entry.original === '') {
      problems.push(`entry ${JSON.stringify(entry)} has no original path`)
      continue
    }
    if (originals.has(entry.original)) problems.push(`${entry.original} is listed twice`)
    originals.add(entry.original)
    if (entry.kind === 'absent') continue
    if (entry.kind !== 'database' && entry.kind !== 'file') {
      problems.push(`${entry.original} has unknown kind ${JSON.stringify(entry.kind)}`)
      continue
    }
    const file = safeStoredPath(entry.file)
    if (file === undefined) {
      problems.push(`${entry.original} is stored at ${JSON.stringify(entry.file)}, outside the backup`)
      continue
    }
    const path = join(dir, file)
    if (!exists(path)) {
      problems.push(`${path} is missing`)
      continue
    }
    if (sha256(path) !== entry.sha256) problems.push(`${path} does not match its sha256 in the manifest`)
    else if (entry.kind === 'database') {
      const found = integrityProblems(path)
      if (found.length > 0) problems.push(`${path} fails the integrity check: ${found.slice(0, 5).join('; ')}`)
    }
  }
  return { manifest, problems }
}

// Puts the data in the backup at dir back where it came from. First checks the whole backup (nothing is
// changed if anything is off), then backs up the data it replaces (to a new directory in baseDir,
// reason "restore", from which a restore goes back), deletes what was absent and the files in the
// backed-up directories that the backup does not have, copies each file back (via a temporary file and
// a rename) and checks the result. Returns that backup of the replaced data.
// Throws a RestoreError saying what was changed.
export async function restore(dir: string, { baseDir = BACKUP_DIR, dataVersion }: { baseDir?: string; dataVersion: number | null }) {
  const { manifest, problems } = readBackup(dir)
  if (!manifest || problems.length > 0) throw new RestoreError(`${dir} cannot be restored, nothing was changed: ${problems.join('; ')}`)
  const holder = manifest.dirs.find((path) => isInside(dir, path))
  if (holder !== undefined) throw new RestoreError(`${dir} is inside ${holder}, which the restore replaces; move the backup out of it first, nothing was changed`)

  const database = manifest.entries.find((entry) => entry.kind === 'database')?.original
  const sidecars = database === undefined ? [] : [`${database}-wal`, `${database}-shm`]
  const listed = new Set(manifest.entries.map((entry) => resolve(entry.original)))
  // Files in the backed-up directories now that the backup does not have
  const extra = manifest.dirs.flatMap((path) => filesIn(resolve(path))).filter((file) => !listed.has(file))
  const inDirs = (original: string) => manifest.dirs.some((path) => !relative(resolve(path), resolve(original)).startsWith('..'))
  const others = manifest.entries.map((entry) => entry.original).filter((original) => original !== database && !sidecars.includes(original) && !inDirs(original))
  let replaced: string
  try {
    replaced = await backup({ database, rawDatabase: true, dirs: manifest.dirs, files: others, baseDir, reason: 'restore', dataVersion })
  } catch (error) {
    throw new RestoreError(`Backing up the current data failed, nothing was restored: ${error instanceof Error ? error.message : error}`)
  }

  const undo = `the data from before the restore is in ${replaced}; run \`pnpm migrate --restore ${replaced}\` to go back to it`
  try {
    for (const entry of manifest.entries) if (entry.kind === 'absent') rm(resolve(entry.original), { force: true })
    for (const file of extra) rm(file, { force: true })
    for (const entry of manifest.entries) {
      if (entry.kind === 'absent') continue
      const target = resolve(entry.original)
      const tmp = `${target}.restoring`
      mkDir(dirname(target), { recursive: true })
      await copyFile(join(dir, entry.file), tmp)
      rename(tmp, target)
    }
  } catch (error) {
    throw new RestoreError(`Restoring failed partway, so the data is partly restored (${error instanceof Error ? error.message : error}); ${undo}`)
  }

  const mismatched = manifest.entries
    .filter((entry) => (entry.kind === 'absent' ? exists(resolve(entry.original)) : !exists(resolve(entry.original)) || sha256(resolve(entry.original)) !== entry.sha256))
    .map((entry) => entry.original)
  mismatched.push(...manifest.dirs.flatMap((path) => filesIn(resolve(path))).filter((file) => !listed.has(file)))
  if (mismatched.length > 0) {
    throw new RestoreError(`After restoring, ${mismatched.join(', ')} do not match the backup; ${undo}`)
  }
  return { manifest, replaced }
}
