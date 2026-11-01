import { readFileSync as readFile } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

// The Grok CLI's public OAuth client; the device code flow needs no client secret
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access'

interface XaiTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  lifetime: number
}

// Fixed path in the project root (cwd), same as config.json. Not configurable, so pnpm xai:login and the bot must
// run in the same directory. Mode 0600, since it holds the tokens. Not read while xaiTTS.apiKey is set. Each machine
// needs its own login: a copy would spend the same single-use refresh token.
export const XAI_TOKEN_FILE = './xai-oauth.json'

export async function xaiEndpoints(): Promise<{ deviceEndpoint: string; tokenEndpoint: string }> {
  const res = await fetch('https://auth.x.ai/.well-known/openid-configuration', { signal: AbortSignal.timeout(20_000) })
  const data = await res.json().catch(() => undefined)
  if (!res.ok || typeof data?.device_authorization_endpoint !== 'string' || typeof data?.token_endpoint !== 'string') {
    throw new Error(`xAI OpenID configuration responded ${res.status} without the device and token endpoints`)
  }
  return { deviceEndpoint: data.device_authorization_endpoint, tokenEndpoint: data.token_endpoint }
}

// A refresh response without a refresh_token keeps the previous one
function tokensFrom(data: Record<string, unknown>, refreshToken?: string): XaiTokens {
  const lifetime = Number(data.expires_in) * 1000
  const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken, expiresAt: Date.now() + lifetime, lifetime }
  if (!validTokens(tokens)) {
    throw new Error('xAI token response is missing access_token, refresh_token or expires_in')
  }
  return tokens
}

export function saveXaiTokens(data: Record<string, unknown>) {
  return withTokenLock(async () => tokensFrom(data))
}

// Empty tokens are rejected too: XaiTTS redacts the access token with replaceAll, which an empty string breaks
function validTokens(tokens: Record<string, unknown> | null): tokens is Record<string, unknown> & XaiTokens {
  return (
    typeof tokens?.accessToken === 'string' &&
    tokens.accessToken !== '' &&
    typeof tokens.refreshToken === 'string' &&
    tokens.refreshToken !== '' &&
    Number.isFinite(tokens.expiresAt) &&
    Number.isFinite(tokens.lifetime)
  )
}

function readTokens(): XaiTokens {
  const tokens = JSON.parse(readFile(XAI_TOKEN_FILE, { encoding: 'utf-8' }))
  if (!validTokens(tokens)) {
    throw new Error(`${XAI_TOKEN_FILE} is not an xAI login; run \`pnpm xai:login\` again`)
  }
  return tokens
}

// Skew by lifetime, not remaining time, so a token shorter than the long skew never looks "about to expire" its whole life
function expiring({ expiresAt, lifetime }: XaiTokens) {
  const longSkew = 60 * 60_000
  return expiresAt - Date.now() < (lifetime < longSkew ? 2 * 60_000 : longSkew)
}

// One refresh at a time across processes through xai-oauth.json.lock: xAI refresh tokens are single-use, so a second refresh with the same one fails with invalid_grant
export async function xaiAccessToken(): Promise<string> {
  const tokens = readTokens()
  if (!expiring(tokens)) return tokens.accessToken
  return withTokenLock(async () => {
    // Another process may have refreshed while this one waited
    const current = readTokens()
    if (!expiring(current)) return current.accessToken
    const { tokenEndpoint } = await xaiEndpoints()
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      // biome-ignore lint/style/useNamingConvention: OAuth parameters
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: XAI_CLIENT_ID, refresh_token: current.refreshToken }),
      signal: AbortSignal.timeout(20_000)
    })
    const data = await res.json().catch(() => undefined)
    if (!res.ok) {
      throw new Error(`xAI token refresh responded ${res.status}: ${data?.error_description ?? data?.error ?? 'no error details'}; run \`pnpm xai:login\` again`)
    }
    return tokensFrom(data, current.refreshToken)
  })
}

// Like git's index.lock, xai-oauth.json is only written through xai-oauth.json.lock: the tokens go into the held
// lock, which is synced and renamed over xai-oauth.json, so the rename installs the file and releases the lock at
// once. A crash mid-write leaves a partial lock for the stale rule to clear, never a partial xai-oauth.json.
// update runs while the lock is held and returns the tokens to save, or an access token to leave the file as it is.
async function withTokenLock(update: () => Promise<XaiTokens | string>): Promise<string> {
  const lock = `${XAI_TOKEN_FILE}.lock`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (!handle) {
    try {
      handle = await open(lock, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A lock left by a process that died mid-refresh; a live refresh holds it at most 40 s (two 20 s requests)
      const lockedAt = (await stat(lock).catch(() => undefined))?.mtimeMs ?? 0
      if (Date.now() - lockedAt > 60_000) await rm(lock, { force: true })
      else await sleep(100)
    }
  }
  // Held past the stale limit, the lock may have been removed and taken by another process
  const { ino } = await handle.stat()
  const owned = async () => (await stat(lock).catch(() => undefined))?.ino === ino
  let renamed = false
  try {
    const result = await update()
    if (typeof result === 'string') return result
    await handle.writeFile(JSON.stringify(result))
    await handle.sync()
    if (!(await owned())) throw new Error(`${lock} was taken over by another process; ${XAI_TOKEN_FILE} was not updated`)
    await handle.close()
    await rename(lock, XAI_TOKEN_FILE)
    renamed = true
    return result.accessToken
  } finally {
    // Checked while the handle is open, so the inode number cannot have been reused by a newer lock
    const ours = !renamed && (await owned())
    await handle.close()
    if (ours) await rm(lock, { force: true })
  }
}
