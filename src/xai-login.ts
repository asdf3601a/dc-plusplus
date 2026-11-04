// Entry point of `pnpm xai:login`: signs in to xAI with the device code flow (RFC 8628) and saves
// ./xai-oauth.json, which XaiTTS uses when xaiTTS.apiKey is empty

import { setTimeout as sleep } from 'node:timers/promises'
import { Logger } from 'tslog'
import { loggerOptions } from './Utils/Config'
import { saveXaiTokens, XAI_CLIENT_ID, XAI_SCOPE, XAI_TOKEN_FILE, xaiEndpoints } from './Utils/XaiOAuth'

const logger = new Logger(loggerOptions).getSubLogger({ name: 'XaiLogin' })

async function login() {
  const { deviceEndpoint, tokenEndpoint } = await xaiEndpoints()
  // biome-ignore lint/style/useNamingConvention: OAuth parameter
  const res = await fetch(deviceEndpoint, { method: 'POST', body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }), signal: AbortSignal.timeout(20_000) })
  const device = await res.json().catch(() => undefined)
  if (!res.ok || typeof device?.device_code !== 'string' || typeof device.user_code !== 'string' || typeof device.verification_uri !== 'string') {
    throw new Error(`xAI device authorization responded ${res.status}: ${device?.error_description ?? device?.error ?? 'no device code'}`)
  }
  logger.info(`Open ${device.verification_uri} and enter the code ${device.user_code}`)

  let interval = Number(device.interval) || 5
  const expiresIn = typeof device.expires_in === 'number' && device.expires_in > 0 ? device.expires_in : 300
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    const poll = await fetch(tokenEndpoint, {
      method: 'POST',
      // biome-ignore lint/style/useNamingConvention: OAuth parameters
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: XAI_CLIENT_ID }),
      signal: AbortSignal.timeout(20_000)
    }).catch((error: unknown) => error)
    // A timeout, a network error or a 5xx only skips this poll; the next one comes after the interval
    if (!(poll instanceof Response) || poll.status >= 500) {
      logger.warn(`xAI token poll failed (${poll instanceof Response ? poll.status : poll instanceof Error ? poll.message : poll}); retrying`)
      continue
    }
    const data = await poll.json().catch(() => undefined)
    if (poll.ok) {
      await saveXaiTokens(data)
      logger.info(`Signed in; the tokens are in ${XAI_TOKEN_FILE}`)
      return
    }
    if (data?.error === 'slow_down') interval += 5
    else if (data?.error !== 'authorization_pending') throw new Error(data?.error_description ?? data?.error ?? `the token endpoint responded ${poll.status}`)
  }
  throw new Error('the code expired before it was approved')
}

login()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`xAI sign-in failed: ${error instanceof Error ? error.message : error}; run \`pnpm xai:login\` again`)
    process.exit(1)
  })
