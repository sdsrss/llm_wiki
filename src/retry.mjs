const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// One network call to an OpenAI-compatible endpoint, hardened for a CLI that must
// not hang forever or die on a transient rate-limit. Per attempt: an
// AbortSignal.timeout ceiling (its timer is unref'd, so it never keeps the process
// alive); retry on 429/5xx and on network/abort errors with exponential backoff.
// On a persistent 429/5xx the final response is returned so the caller raises its
// own "API error <status>"; on a persistent network/abort error the last error is
// thrown. retries=0 disables retry (immediate surface — used by tests).
export async function fetchWithRetry(fetchImpl, url, opts, { dispatcher, timeoutMs = 120000, retries = 3, backoffMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, {
        ...opts,
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      })
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt)
        continue
      }
      return res
    } catch (err) {
      if (attempt >= retries) throw err
      await sleep(backoffMs * 2 ** attempt)
    }
  }
}
