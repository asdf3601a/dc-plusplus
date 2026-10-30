import { existsSync as exists, readdirSync as readDir } from 'node:fs'
import { extname } from 'node:path'
import type { AssetV1 } from './types'
import { v1ToV2 } from './v1-to-v2'

export const ASSETS_DIR = 'assets'

// An assets/<id>.json already checked to be a JSON object
type Asset = Record<string, unknown>

// ASSET_STEPS[n] converts one assets/<id>.json from data version n to n + 1. Returns undefined when
// the file needs no change, so running a step again on converted data changes nothing. Steps run in
// order, so the file a step gets is at its version.
export const ASSET_STEPS: Record<number, (config: Asset) => Asset | undefined> = {
  1: (config) => v1ToV2(config as AssetV1)
}

// Names of the assets/<id>.json files; .wav files are never read or touched
export function assetConfigFiles(): string[] {
  if (!exists(ASSETS_DIR)) return []
  return readDir(ASSETS_DIR)
    .filter((file) => extname(file) === '.json')
    .sort()
}
