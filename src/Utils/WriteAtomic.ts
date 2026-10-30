import { rename, rm, writeFile } from 'node:fs/promises'

export const TEMP_SUFFIX = '.tmp'

let tempCounter = 0

// The path only ever holds a complete file: a crash mid-write leaves just a <path>.<pid>.<n>.tmp file.
// The temp file must be in the same dir for rename to be atomic.
export async function writeAtomic(path: string, data: string | Uint8Array) {
  const temp = `${path}.${process.pid}.${++tempCounter}${TEMP_SUFFIX}`
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
