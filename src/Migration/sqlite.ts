// Direct SQLite access for `pnpm migrate` (node:sqlite), for what Prisma cannot do: copying a database
// file, checking one, and finding out whether another connection holds it locked.
import { copyFileSync as copyFile, existsSync as exists, mkdtempSync as mkdtemp, rmSync as rm } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

const SQLITE_BUSY = 5
// How long `pnpm migrate` waits for another connection to release the database: 5 tries, 2 s apart
const LOCK_TRIES = 5
const LOCK_RETRY_MS = 2000
// Busy timeout for the backup copy, which only needs to read
const READ_TIMEOUT_MS = 10_000

function isBusy(error: unknown) {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY
}

// A consistent copy of the database at path in dest, even while the bot is using it
export function vacuumInto(path: string, dest: string) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: READ_TIMEOUT_MS })
  try {
    db.prepare('VACUUM INTO ?').run(dest)
  } finally {
    db.close()
  }
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
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(copy)
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
// connection holds the database at path locked, then returns undefined; still locked, returns what holds
// it. Takes the lock only for a moment and changes nothing.
export async function databaseLock(path: string, onRetry: (attempt: number, tries: number, waitMs: number) => void) {
  const db = new DatabaseSync(path, { timeout: 0 })
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        db.exec('BEGIN EXCLUSIVE')
        db.exec('ROLLBACK')
        return undefined
      } catch (error) {
        if (!isBusy(error)) throw error
      }
      if (attempt === LOCK_TRIES) break
      onRetry(attempt, LOCK_TRIES, LOCK_RETRY_MS)
      await sleep(LOCK_RETRY_MS)
    }
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec('ROLLBACK')
    } catch (error) {
      if (isBusy(error)) return 'another connection is writing to it (is the bot or another `pnpm migrate` running?)'
      throw error
    }
    return 'another connection has a read transaction open (e.g. an sqlite3 shell or a database browser)'
  } finally {
    db.close()
  }
}

// Names of the Prisma migrations recorded as failed: started, not finished, not marked rolled back.
// Empty when the database or the history table does not exist.
export function failedMigrations(path: string): string[] {
  if (!exists(path)) return []
  const db = new DatabaseSync(path, { readOnly: true, timeout: READ_TIMEOUT_MS })
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'").all()
    if (table.length === 0) return []
    const rows = db.prepare('SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL').all() as { name: string }[]
    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}
