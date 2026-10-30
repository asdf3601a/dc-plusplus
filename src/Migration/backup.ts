import { constants, mkdirSync as mkDir } from 'node:fs'
import { copyFile, unlink } from 'node:fs/promises'
import { ASSETS_DIR } from './assets/steps'

export const BACKUP_DIR = 'backup'

// YYYYMMDD-HHmmss in local time
function backupTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

// backup/<name>-<YYYYMMDD-HHmmss>, creating backup/
function backupPath(name: string) {
  mkDir(BACKUP_DIR, { recursive: true })
  return `${BACKUP_DIR}/${name}-${backupTimestamp()}`
}

// Copies the files to backup/assets-<YYYYMMDD-HHmmss>/ and returns that directory. Throws if any copy
// fails; an existing backup is never overwritten.
export async function backupAssets(files: string[]): Promise<string> {
  const backupDir = backupPath('assets')
  // Not recursive: fails if the directory exists
  mkDir(backupDir)
  for (const file of files) await copyFile(`${ASSETS_DIR}/${file}`, `${backupDir}/${file}`, constants.COPYFILE_EXCL)
  return backupDir
}

// Moves the file to backup/<name>-<YYYYMMDD-HHmmss>.json and returns that path. Copies first so an
// existing backup is never overwritten, then removes the original.
export async function moveToBackup(path: string, name: string) {
  const target = `${backupPath(name)}.json`
  await copyFile(path, target, constants.COPYFILE_EXCL)
  await unlink(path)
  return target
}
