import { setTimeout as sleep } from 'node:timers/promises'

// fetch that retries a 429, a 5xx or a network error up to twice, after 0.5 s then 1 s or the Retry-After.
// An abort of the signal also ends a retry wait.
export async function fetchWithRetry(url: string, init: RequestInit & { signal: AbortSignal }) {
  for (let retries = 0; ; retries++) {
    const result = await fetch(url, init).catch((error: unknown) => error)
    if (result instanceof Response && result.status !== 429 && result.status < 500) return result
    const header = (result instanceof Response && result.headers.get('retry-after')) || ''
    const after = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
    const wait = Number.isNaN(after) ? 500 << retries : Math.max(after, 0)
    if (retries === 2) {
      if (result instanceof Response) return result
      throw result
    }
    // The body is never read on a retry, so drop it before opening the next request
    if (result instanceof Response) await result.body?.cancel()
    await sleep(wait, undefined, { signal: init.signal })
  }
}
