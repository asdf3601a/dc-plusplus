import { readFileSync as readFile } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeAtomic } from './WriteAtomic'

// The Grok CLI's public OAuth client; the device code flow needs no client secret
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access'

interface XaiTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  lifetime: number
}

// Fixed path in the project root (cwd), same as config.json. Not configurable.
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
export async function saveXaiTokens(data: Record<string, unknown>, refreshToken?: string) {
  const lifetime = Number(data.expires_in) * 1000
  const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken, expiresAt: Date.now() + lifetime, lifetime }
  if (!validTokens(tokens)) {
    throw new Error('xAI token response is missing access_token, refresh_token or expires_in')
  }
  await writeAtomic(XAI_TOKEN_FILE, JSON.stringify(tokens), 0o600)
  return tokens
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
  return refresh()
}

async function refresh() {
  const lock = `${XAI_TOKEN_FILE}.lock`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (!handle) {
    try {
      handle = await open(lock, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A lock left by a process that died mid-refresh; a live refresh holds it at most 40 s (two 20 s requests)
      const lockedAt = (await stat(lock).catch(() => undefined))?.mtimeMs ?? 0
      if (Date.now() - lockedAt > 60_000) await rm(lock, { force: true })
      else await sleep(100)
    }
  }
  try {
    // Another process may have refreshed while this one waited
    const tokens = readTokens()
    if (!expiring(tokens)) return tokens.accessToken
    const { tokenEndpoint } = await xaiEndpoints()
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      // biome-ignore lint/style/useNamingConvention: OAuth parameters
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: XAI_CLIENT_ID, refresh_token: tokens.refreshToken }),
      signal: AbortSignal.timeout(20_000)
    })
    const data = await res.json().catch(() => undefined)
    if (!res.ok) {
      throw new Error(`xAI token refresh responded ${res.status}: ${data?.error_description ?? data?.error ?? 'no error details'}; run \`pnpm xai:login\` again`)
    }
    return (await saveXaiTokens(data, tokens.refreshToken)).accessToken
  } finally {
    await handle.close()
    await rm(lock, { force: true })
  }
}
