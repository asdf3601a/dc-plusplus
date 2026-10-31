import { constants, mkdirSync as mkDir, rmSync as rm } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { ASSETS_DIR } from './assets/steps'

export const BACKUP_DIR = 'backup'

// YYYYMMDD-HHmmss in local time
function backupTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

// Copies into backup/<YYYYMMDD-HHmmss>/ and returns that directory: the database (VACUUM INTO, a
// consistent copy even while the bot is running), the assets/<id>.json files to assets/, and the other
// files by name. Throws if anything fails, after removing the unfinished backup; never overwrites one.
export async function backup({ database, assets, files }: { database?: string; assets: string[]; files: string[] }) {
  mkDir(BACKUP_DIR, { recursive: true })
  const dir = `${BACKUP_DIR}/${backupTimestamp()}`
  // Not recursive: fails if the directory exists
  mkDir(dir)
  try {
    if (database !== undefined) {
      const { prisma } = await import('../Core/SQLite/Client')
      await prisma.$executeRawUnsafe('VACUUM INTO ?', resolve(dir, basename(database)))
    }
    if (assets.length > 0) mkDir(`${dir}/${ASSETS_DIR}`)
    for (const file of assets) await copyFile(`${ASSETS_DIR}/${file}`, `${dir}/${ASSETS_DIR}/${file}`, constants.COPYFILE_EXCL)
    for (const file of files) await copyFile(file, `${dir}/${basename(file)}`, constants.COPYFILE_EXCL)
  } catch (error) {
    rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}
