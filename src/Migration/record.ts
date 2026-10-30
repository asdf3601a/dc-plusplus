import { existsSync as exists, readFileSync as readFile } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { instances } from '../Utils/Instances'
import { writeAtomic } from '../Utils/WriteAtomic'

// data-version.json: the data version the app-side data was last migrated to
const RECORD_FILE = 'data-version.json'

type VersionRecord = { kind: 'none' } | { kind: 'ok'; version: number } | { kind: 'invalid'; reason: string }

// The record lives next to the SQLite database file
export function recordFilePath() {
  return resolve(dirname(databasePath()), RECORD_FILE)
}

export function databasePath() {
  const url = instances.config.sqlite.databaseUrl
  if (!url.startsWith('file:')) throw new Error(`Unsupported database URL ${url}`)
  return resolve(url.slice('file:'.length).split('?')[0])
}

export function readRecord(path: string): VersionRecord {
  if (!exists(path)) return { kind: 'none' }
  let version: unknown
  try {
    version = JSON.parse(readFile(path, { encoding: 'utf-8' }))?.version
  } catch {
    return { kind: 'invalid', reason: `${path} is not valid JSON` }
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'invalid', reason: `${path} has no valid "version" (expected a positive integer, got ${JSON.stringify(version)})` }
  }
  return { kind: 'ok', version }
}

export async function writeRecord(path: string, version: number) {
  await writeAtomic(path, `${JSON.stringify({ version }, null, 2)}\n`)
}
