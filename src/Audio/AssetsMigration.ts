import { constants, existsSync as exists, mkdirSync as mkDir, readdirSync as readDir } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { BACKUP_DIR, backupTimestamp } from '../Utils/Backup'
import type { MemberConfig } from './Audio'

export const ASSETS_DIR = 'assets'
// Old format: use_wave_tts true with a voice -> Google Cloud, anything else -> Google Translate
const LEGACY_KEY = 'use_wave_tts'

// ASSET_STEPS[n] converts one assets/<id>.json from data version n to n + 1. Returns undefined when
// the file needs no change, so running a step again on converted data changes nothing.
export const ASSET_STEPS: Record<number, (config: MemberConfig) => MemberConfig | undefined> = {
  1: useWaveTTSToProvider
}

// Names of the assets/<id>.json files; .wav files are never read or touched
export function assetConfigFiles(): string[] {
  if (!exists(ASSETS_DIR)) return []
  return readDir(ASSETS_DIR)
    .filter((file) => extname(file) === '.json')
    .sort()
}

// Copies the files to backup/assets-<YYYYMMDD-HHmmss>/ and returns that directory. Throws if any copy
// fails; an existing backup is never overwritten.
export async function backupAssets(files: string[]): Promise<string> {
  const backupDir = `${BACKUP_DIR}/assets-${backupTimestamp()}`
  mkDir(BACKUP_DIR, { recursive: true })
  // Not recursive: fails if the directory exists
  mkDir(backupDir)
  for (const file of files) await copyFile(`${ASSETS_DIR}/${file}`, `${backupDir}/${file}`, constants.COPYFILE_EXCL)
  return backupDir
}

// 1 -> 2: replace use_wave_tts with a provider id; a provider that is already set is kept
function useWaveTTSToProvider(config: MemberConfig): MemberConfig | undefined {
  const hasProvider = typeof config.provider === 'string'
  if (hasProvider && !(LEGACY_KEY in config)) return undefined
  // use_wave_tts without a voice fell back to Google Translate at runtime; match that, not the flag alone
  const usedWaveTTS = Boolean(config[LEGACY_KEY]) && Boolean(config.voice)
  const migrated: MemberConfig = {
    provider: hasProvider ? config.provider : usedWaveTTS ? 'google-cloud' : 'google-translate'
  }
  for (const [key, value] of Object.entries(config)) {
    if (key !== LEGACY_KEY && key !== 'provider') migrated[key] = value
  }
  return migrated
}
