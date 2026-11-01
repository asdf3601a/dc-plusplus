// Direct SQLite access for `pnpm migrate` (better-sqlite3, the driver Prisma uses too), for what Prisma cannot do: copying a database
// file, checking one, finding out whether another connection holds it locked, and reading what the
// generated client cannot see: SQLite's and Prisma's own tables (sqlite_master, _prisma_migrations) and
// columns that only exist before a migration (the old serverConfig.ttsType; the client follows the new schema).
import { copyFileSync as copyFile, existsSync as exists, mkdtempSync as mkdtemp, rmSync as rm } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'

// How long `pnpm migrate` waits for another connection to release the database: 5 tries, 2 s apart
const LOCK_TRIES = 5
const LOCK_RETRY_MS = 2000
// Busy timeout for the readonly connections (backup copy and reads)
const READ_TIMEOUT_MS = 10_000

// SQLITE_BUSY, or one of its extended codes (SQLITE_BUSY_RECOVERY, ...)
function isBusy(error: unknown) {
  if (!(error instanceof Database.SqliteError)) return false
  return error.code === 'SQLITE_BUSY' || error.code.startsWith('SQLITE_BUSY_')
}

// Runs read on a readonly connection to the database at path, closing it afterwards
function readOnly<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, timeout: READ_TIMEOUT_MS })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

// A consistent copy of the database at path in dest, even while the bot is using it
export function vacuumInto(path: string, dest: string) {
  readOnly(path, (db) => db.prepare('VACUUM INTO ?').run(dest))
}

// PRAGMA integrity_check of the database file at path (and its -wal next to it), run on a copy in a
// temporary directory so the file itself is never opened for writing. Returns the problems found, or
// an empty list.
export function integrityProblems(path: string): string[] {
  const tmp = mkdtemp(join(tmpdir(), 'voice-log-check-'))
  try {
    const copy = join(tmp, 'check.db')
    copyFile(path, copy)
    if (exists(`${path}-wal`)) copyFile(`${path}-wal`, `${copy}-wal`)
    let db: Database.Database | undefined
    try {
      db = new Database(copy)
      const rows = db.prepare('SELECT integrity_check AS result FROM pragma_integrity_check').all() as { result: string }[]
      const problems = rows.map((row) => row.result)
      return problems.length === 1 && problems[0] === 'ok' ? [] : problems
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)]
    } finally {
      db?.close()
    }
  } finally {
    rm(tmp, { recursive: true, force: true })
  }
}

// Waits (LOCK_TRIES tries, LOCK_RETRY_MS apart, calling onRetry before each wait) until no other
// connection holds the database at path locked, then returns false; true if it is still locked. Takes
// the lock only for a moment and changes nothing.
export async function databaseLocked(path: string, onRetry: (attempt: number, tries: number, waitMs: number) => void) {
  const db = new Database(path, { timeout: 0 })
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        db.exec('BEGIN EXCLUSIVE')
        db.exec('ROLLBACK')
        return false
      } catch (error) {
        if (!isBusy(error)) throw error
      }
      if (attempt === LOCK_TRIES) return true
      onRetry(attempt, LOCK_TRIES, LOCK_RETRY_MS)
      await sleep(LOCK_RETRY_MS)
    }
  } finally {
    db.close()
  }
}

// Names of the Prisma migrations the database has finished applying ("applied") or recorded as failed
// (started, not finished: "failed"), not marked rolled back. Empty when the database or the history
// table does not exist.
export function migrationNames(path: string, state: 'applied' | 'failed'): string[] {
  if (!exists(path)) return []
  return readOnly(path, (db) => {
    if (!hasTable(db, '_prisma_migrations')) return []
    const finished = state === 'applied' ? 'IS NOT NULL' : 'IS NULL'
    const rows = db.prepare(`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at ${finished} AND rolled_back_at IS NULL`).all() as { name: string }[]
    return rows.map((row) => row.name)
  })
}

// serverConfig rows whose ttsType is not one of mapped. Empty when the database or the table does not exist.
export function unmappedTTSTypes(path: string, mapped: readonly string[]): { serverID: string; ttsType: string }[] {
  if (!exists(path)) return []
  return readOnly(path, (db) => {
    if (!hasTable(db, 'serverConfig')) return []
    const placeholders = mapped.map(() => '?').join(', ')
    return db.prepare(`SELECT serverID, ttsType FROM serverConfig WHERE ttsType NOT IN (${placeholders})`).all(...mapped) as { serverID: string; ttsType: string }[]
  })
}

function hasTable(db: Database.Database, name: string) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}
