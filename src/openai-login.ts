// Entry point of `pnpm openai:login`: signs in to ChatGPT with the Codex device code flow and saves
// ./openai-oauth.json, which OpenaiTTS uses when openaiTTS.apiKey is empty

import { setTimeout as sleep } from 'node:timers/promises'
import { Logger } from 'tslog'
import { loggerOptions } from './Utils/Config'
import { OPENAI_CLIENT_ID, OPENAI_ISSUER, OPENAI_TOKEN_FILE, saveOpenaiTokens } from './Utils/OpenaiOAuth'

const logger = new Logger(loggerOptions).getSubLogger({ name: 'OpenaiLogin' })

function postJson(path: string, body: object) {
  return fetch(`${OPENAI_ISSUER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  })
}

async function login() {
  // biome-ignore lint/style/useNamingConvention: OAuth parameter
  const res = await postJson('/api/accounts/deviceauth/usercode', { client_id: OPENAI_CLIENT_ID })
  const device = await res.json().catch(() => undefined)
  if (!res.ok || typeof device?.device_auth_id !== 'string' || typeof device.user_code !== 'string') {
    throw new Error(`OpenAI device authorization responded ${res.status} without a device code`)
  }
  logger.info(`Open ${OPENAI_ISSUER}/codex/device and enter the code ${device.user_code}`)

  const interval = Math.max(3, Number(device.interval) || 5)
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    // biome-ignore lint/style/useNamingConvention: OAuth parameters
    const poll = await postJson('/api/accounts/deviceauth/token', { device_auth_id: device.device_auth_id, user_code: device.user_code })
    if (poll.status === 403 || poll.status === 404) continue
    const code = await poll.json().catch(() => undefined)
    if (!poll.ok || typeof code?.authorization_code !== 'string' || typeof code.code_verifier !== 'string') {
      throw new Error(`the device authorization poll responded ${poll.status} without an authorization code`)
    }
    const token = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        // biome-ignore lint/style/useNamingConvention: OAuth parameters
        grant_type: 'authorization_code',
        code: code.authorization_code,
        // biome-ignore lint/style/useNamingConvention: OAuth parameters
        redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
        // biome-ignore lint/style/useNamingConvention: OAuth parameters
        client_id: OPENAI_CLIENT_ID,
        // biome-ignore lint/style/useNamingConvention: OAuth parameters
        code_verifier: code.code_verifier
      })
    })
    const data = await token.json().catch(() => undefined)
    if (!token.ok) {
      throw new Error(`the token exchange responded ${token.status}: ${data?.error_description ?? data?.error?.message ?? data?.error ?? 'no error details'}`)
    }
    await saveOpenaiTokens(data)
    logger.info(`Signed in; the tokens are in ${OPENAI_TOKEN_FILE}`)
    return
  }
  throw new Error('the code expired before it was approved')
}

login()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`OpenAI sign-in failed: ${error instanceof Error ? error.message : error}; run \`pnpm openai:login\` again`)
    process.exit(1)
  })
