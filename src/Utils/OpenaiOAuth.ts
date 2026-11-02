import { existsSync as exists, readFileSync as readFile } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

// The Codex CLI's public OAuth client
export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_ISSUER = 'https://auth.openai.com'

interface OpenaiTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

// Fixed path in the project root (cwd), same as config.json. Not configurable, so pnpm openai:login and the bot
// must run in the same directory. Mode 0600, since it holds the tokens. Not read while openaiTTS.apiKey is set.
// Each machine needs its own login: a copy would spend the same single-use refresh token.
export const OPENAI_TOKEN_FILE = './openai-oauth.json'

// expiresAt comes from the exp claim of the access token
function expiryOf(accessToken: unknown) {
  try {
    return JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString()).exp * 1000
  } catch {
    return Number.NaN
  }
}

// A refresh response without a refresh_token keeps the previous one
function tokensFrom(data: Record<string, unknown>, refreshToken?: string): OpenaiTokens {
  const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken, expiresAt: expiryOf(data.access_token) }
  if (!validTokens(tokens)) {
    throw new Error('OpenAI token response is missing access_token or refresh_token, or the access token has no expiry')
  }
  return tokens
}

export function saveOpenaiTokens(data: Record<string, unknown>) {
  return withTokenLock(async () => tokensFrom(data))
}

// Empty tokens are rejected too: OpenaiTTS redacts the access token with replaceAll, which an empty string breaks
function validTokens(tokens: Record<string, unknown> | null): tokens is Record<string, unknown> & OpenaiTokens {
  return (
    typeof tokens?.accessToken === 'string' &&
    tokens.accessToken !== '' &&
    typeof tokens.refreshToken === 'string' &&
    tokens.refreshToken !== '' &&
    Number.isFinite(tokens.expiresAt)
  )
}

function readTokens(): OpenaiTokens {
  if (!exists(OPENAI_TOKEN_FILE)) {
    throw new Error(`openaiTTS.apiKey is not set and there is no ${OPENAI_TOKEN_FILE}; run \`pnpm openai:login\``)
  }
  let tokens: Record<string, unknown> | null
  try {
    tokens = JSON.parse(readFile(OPENAI_TOKEN_FILE, { encoding: 'utf-8' }))
  } catch (error) {
    throw new Error(`${OPENAI_TOKEN_FILE} is not valid JSON: ${error instanceof Error ? error.message : error}; run \`pnpm openai:login\` again`)
  }
  if (!validTokens(tokens)) {
    throw new Error(`${OPENAI_TOKEN_FILE} is not an OpenAI login; run \`pnpm openai:login\` again`)
  }
  return tokens
}

// 5 minutes or less left: long enough for one synthesis to finish before the token expires
function expiring({ expiresAt }: OpenaiTokens) {
  return expiresAt - Date.now() <= 5 * 60_000
}

// One refresh at a time across processes through openai-oauth.json.lock, so two processes never spend the same
// refresh token
export async function openaiAccessToken(): Promise<string> {
  const tokens = readTokens()
  if (!expiring(tokens)) return tokens.accessToken
  return withTokenLock(async () => {
    // Another process may have refreshed while this one waited
    const current = readTokens()
    if (!expiring(current)) return current.accessToken
    const res = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
      method: 'POST',
      // biome-ignore lint/style/useNamingConvention: OAuth parameters
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: OPENAI_CLIENT_ID, refresh_token: current.refreshToken }),
      signal: AbortSignal.timeout(20_000)
    })
    const data = await res.json().catch(() => undefined)
    if (!res.ok) {
      throw new Error(
        `OpenAI token refresh responded ${res.status}: ${data?.error_description ?? data?.error?.message ?? data?.error ?? 'no error details'}; run \`pnpm openai:login\` again`
      )
    }
    return tokensFrom(data, current.refreshToken)
  })
}

// Like git's index.lock, openai-oauth.json is only written through openai-oauth.json.lock: the tokens go into the
// held lock, which is synced and renamed over openai-oauth.json, so the rename installs the file and releases the
// lock at once. A crash mid-write leaves a partial lock for the stale rule to clear, never a partial openai-oauth.json.
// update runs while the lock is held and returns the tokens to save, or an access token to leave the file as it is.
async function withTokenLock(update: () => Promise<OpenaiTokens | string>): Promise<string> {
  const lock = `${OPENAI_TOKEN_FILE}.lock`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (!handle) {
    try {
      handle = await open(lock, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A lock left by a process that died mid-refresh; a live refresh holds it at most 20 s (one 20 s request)
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
    if (!(await owned())) throw new Error(`${lock} was taken over by another process; ${OPENAI_TOKEN_FILE} was not updated`)
    await handle.close()
    await rename(lock, OPENAI_TOKEN_FILE)
    renamed = true
    return result.accessToken
  } finally {
    // Checked while the handle is open, so the inode number cannot have been reused by a newer lock
    const ours = !renamed && (await owned())
    await handle.close()
    if (ours) await rm(lock, { force: true })
  }
}
