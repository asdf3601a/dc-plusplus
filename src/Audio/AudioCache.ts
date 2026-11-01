import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, stat, unlink, utimes } from 'node:fs/promises'
import type { ILogObj, Logger } from 'tslog'
import { TEMP_SUFFIX, writeAtomic } from '../Utils/WriteAtomic'
import type { AudioFormat } from './AudioAsset'
import type { TTSProvider } from './TTSProvider'

const EXTENSIONS: Record<AudioFormat, string> = { ogg: 'opus', pcm: 'pcm' }
// Files used this recently are never evicted, whatever the size and age limits, so a file that is
// queued or playing (up to DEFAULT_PLAYBACK_TIMEOUT_MS, 2 minutes) is not deleted under the player
export const RECENT_USE_MS = 10 * 60 * 1000

export interface AudioCacheOptions {
  dir?: string
  // Least recently used files are removed while the cache is larger than this
  maxBytes?: number
  // Files not used for this long are removed
  maxAgeMs?: number
  // Eviction runs this long after a new file is written (one run per window)
  evictDelayMs?: number
  logger?: Logger<ILogObj>
}

export interface EvictionResult {
  removed: number
  freedBytes: number
  keptBytes: number
}

// A file's mtime is its last use: set when written and bumped on every cache hit.
export class AudioCache {
  private readonly dir: string
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private readonly evictDelayMs: number
  private readonly logger: Logger<ILogObj> | undefined
  private readonly inFlight = new Map<string, Promise<string | null>>()
  private evicting: Promise<EvictionResult> | undefined
  private evictTimer: NodeJS.Timeout | undefined

  constructor(options: AudioCacheOptions = {}) {
    this.dir = options.dir ?? './caches'
    this.maxBytes = options.maxBytes ?? 500 * 1024 * 1024
    this.maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000
    this.evictDelayMs = options.evictDelayMs ?? 60 * 1000
    this.logger = options.logger?.getSubLogger({ name: 'AudioCache' })
  }

  private pathFor(provider: TTSProvider, text: string, lang: string, voice = ''): string {
    return `${this.dir}/${createHash('md5').update(`${provider.id}:${text}-${lang}-${voice}`).digest('hex')}.${EXTENSIONS[provider.format]}`
  }

  // Resolves to the cached file path, synthesizing it on a miss; null when synthesis failed.
  // Concurrent misses for the same key share one synthesis and one write.
  public async getOrCreate(provider: TTSProvider, text: string, lang: string, voice = ''): Promise<string | null> {
    const path = this.pathFor(provider, text, lang, voice)
    if (existsSync(path)) {
      await this.touch(path)
      return path
    }
    const pending = this.inFlight.get(path)
    if (pending) return pending
    const created = this.create(provider, path, text, lang, voice).finally(() => this.inFlight.delete(path))
    this.inFlight.set(path, created)
    return created
  }

  // Removes files unused for maxAgeMs, then the least recently used ones until the cache fits in
  // maxBytes. In-flight and *.tmp files, and files used within RECENT_USE_MS, are never touched.
  // Concurrent calls share one run.
  public evict(now = Date.now()): Promise<EvictionResult> {
    if (!this.evicting) {
      this.evicting = this.runEviction(now)
        .catch((error) => {
          this.logger?.error('Cache eviction failed:', error)
          return { removed: 0, freedBytes: 0, keptBytes: 0 }
        })
        .finally(() => {
          this.evicting = undefined
        })
    }
    return this.evicting
  }

  private async runEviction(now: number): Promise<EvictionResult> {
    const files: { path: string; size: number; usedAt: number }[] = []
    for (const name of await readdir(this.dir)) {
      const path = `${this.dir}/${name}`
      if (!this.isEvictable(path)) continue
      const info = await stat(path).catch(() => undefined)
      if (info?.isFile()) files.push({ path, size: info.size, usedAt: info.mtimeMs })
    }

    // Keep the most recently used files; once one is too old or does not fit, every older file goes too
    files.sort((a, b) => b.usedAt - a.usedAt)
    const result: EvictionResult = { removed: 0, freedBytes: 0, keptBytes: 0 }
    let full = false
    for (const file of files) {
      if (now - file.usedAt < RECENT_USE_MS) {
        result.keptBytes += file.size
        continue
      }
      full ||= now - file.usedAt > this.maxAgeMs || result.keptBytes + file.size > this.maxBytes
      if (!full) {
        result.keptBytes += file.size
      } else if (await this.remove(file.path, file.usedAt)) {
        result.removed++
        result.freedBytes += file.size
      } else {
        result.keptBytes += file.size
      }
    }
    if (result.removed > 0) {
      this.logger?.info(`Evicted ${result.removed} cache files (${toMiB(result.freedBytes)} MiB), ${toMiB(result.keptBytes)} MiB kept`)
    }
    return result
  }

  // Whether a file in the cache dir may be deleted now: never a *.tmp file or one being written
  public isEvictable(path: string) {
    return !path.endsWith(TEMP_SUFFIX) && !this.inFlight.has(path)
  }

  // Skips the file if it was used or rewritten after it was listed
  private async remove(path: string, usedAt: number) {
    if (!this.isEvictable(path)) return false
    const info = await stat(path).catch(() => undefined)
    if (!info || info.mtimeMs !== usedAt) return false
    try {
      await unlink(path)
      return true
    } catch {
      return false
    }
  }

  private async touch(path: string) {
    const now = new Date()
    await utimes(path, now, now).catch(() => undefined)
  }

  private scheduleEviction() {
    if (this.evictTimer) return
    this.evictTimer = setTimeout(() => {
      this.evictTimer = undefined
      this.evict()
    }, this.evictDelayMs)
    this.evictTimer.unref()
  }

  private async create(provider: TTSProvider, path: string, text: string, lang: string, voice: string): Promise<string | null> {
    const data = await provider.synthesize(text, lang, voice)
    if (data === null) return null
    // A crash mid-write leaves only a *.tmp file, which never matches a cache key
    try {
      await writeAtomic(path, data)
    } catch (error) {
      // Same as a failed synthesis: log it and play nothing, never reject the caller
      this.logger?.error(`Failed to write cache file ${path}:`, error)
      return null
    }
    this.scheduleEviction()
    return path
  }
}

function toMiB(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1)
}
