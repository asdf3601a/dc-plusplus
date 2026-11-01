import { readFileSync as readFile } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

// Outside the repo by default, so the tokens are never committed or copied with a checkout
export function xaiTokenFile(configured: string) {
  return configured || join(process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'discord-voice-log', 'xai-oauth.json')
}

export async function xaiEndpoints(): Promise<{ deviceEndpoint: string; tokenEndpoint: string }> {
  const res = await fetch('https://auth.x.ai/.well-known/openid-configuration', { signal: AbortSignal.timeout(20_000) })
  const data = await res.json().catch(() => undefined)
  if (!res.ok || typeof data?.device_authorization_endpoint !== 'string' || typeof data?.token_endpoint !== 'string') {
    throw new Error(`xAI OpenID configuration responded ${res.status} without the device and token endpoints`)
  }
  return { deviceEndpoint: data.device_authorization_endpoint, tokenEndpoint: data.token_endpoint }
}

// A refresh response without a refresh_token keeps the previous one
export async function saveXaiTokens(file: string, data: Record<string, unknown>, refreshToken?: string) {
  const lifetime = Number(data.expires_in) * 1000
  const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken, expiresAt: Date.now() + lifetime, lifetime }
  if (!validTokens(tokens)) {
    throw new Error('xAI token response is missing access_token, refresh_token or expires_in')
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeAtomic(file, JSON.stringify(tokens), 0o600)
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

function readTokens(file: string): XaiTokens {
  const tokens = JSON.parse(readFile(file, { encoding: 'utf-8' }))
  if (!validTokens(tokens)) {
    throw new Error(`${file} is not an xAI login; run \`pnpm xai:login\` again`)
  }
  return tokens
}

// Skew by lifetime, not remaining time, so a token shorter than the long skew never looks "about to expire" its whole life
function expiring({ expiresAt, lifetime }: XaiTokens) {
  const longSkew = 60 * 60_000
  return expiresAt - Date.now() < (lifetime < longSkew ? 2 * 60_000 : longSkew)
}

let refreshing: Promise<string> | undefined

// One refresh at a time, in this process and across processes through <file>.lock: xAI refresh tokens
// are single-use, so a second refresh with the same one fails with invalid_grant
export async function xaiAccessToken(file: string): Promise<string> {
  const tokens = readTokens(file)
  if (!expiring(tokens)) return tokens.accessToken
  refreshing ??= refresh(file).finally(() => {
    refreshing = undefined
  })
  return refreshing
}

async function refresh(file: string) {
  const lock = `${file}.lock`
  const started = Date.now()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (!handle) {
    try {
      handle = await open(lock, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A lock left by a process that died mid-refresh; a live refresh holds it at most 40 s (two 20 s requests)
      const lockedAt = (await stat(lock).catch(() => undefined))?.mtimeMs ?? 0
      if (Date.now() - lockedAt > 60_000) await rm(lock, { force: true })
      else if (Date.now() - started > 60_000) throw new Error(`timed out waiting for ${lock}`)
      else await sleep(100)
    }
  }
  try {
    // Another process may have refreshed while this one waited
    const tokens = readTokens(file)
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
    return (await saveXaiTokens(file, data, tokens.refreshToken)).accessToken
  } finally {
    await handle.close()
    await rm(lock, { force: true })
  }
}
