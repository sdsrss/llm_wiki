import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithRetry } from '../src/retry.mjs'

const FAST = { backoffMs: 1 } // keep the suite hermetic and quick

test('fetchWithRetry retries a 429 then returns the success', async () => {
  let n = 0
  const fetchImpl = async () => (++n < 3
    ? { ok: false, status: 429 }
    : { ok: true, status: 200 })
  const res = await fetchWithRetry(fetchImpl, 'u', {}, { ...FAST, retries: 3 })
  assert.equal(res.status, 200)
  assert.equal(n, 3, 'two 429s retried, third attempt succeeded')
})

test('fetchWithRetry returns the last response after exhausting retries on 5xx', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return { ok: false, status: 503 } }
  const res = await fetchWithRetry(fetchImpl, 'u', {}, { ...FAST, retries: 2 })
  assert.equal(res.status, 503, 'caller gets the final 5xx to raise its own API error')
  assert.equal(n, 3, 'initial attempt + 2 retries')
})

test('fetchWithRetry does not retry a non-retryable 4xx', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return { ok: false, status: 400 } }
  const res = await fetchWithRetry(fetchImpl, 'u', {}, { ...FAST, retries: 3 })
  assert.equal(res.status, 400)
  assert.equal(n, 1, 'a 400 is a client error — surface immediately')
})

test('fetchWithRetry retries a thrown network error then succeeds', async () => {
  let n = 0
  const fetchImpl = async () => { if (++n < 2) throw new Error('ECONNRESET'); return { ok: true, status: 200 } }
  const res = await fetchWithRetry(fetchImpl, 'u', {}, { ...FAST, retries: 3 })
  assert.equal(res.status, 200)
  assert.equal(n, 2)
})

test('fetchWithRetry throws when a network error persists past retries', async () => {
  let n = 0
  const fetchImpl = async () => { n++; throw new Error('ECONNRESET') }
  await assert.rejects(() => fetchWithRetry(fetchImpl, 'u', {}, { ...FAST, retries: 2 }), /ECONNRESET/)
  assert.equal(n, 3)
})

test('fetchWithRetry aborts a hung request via the timeout signal', async () => {
  // A fetch that never resolves on its own but honors the abort signal (as real fetch
  // does). AbortSignal.timeout's timer is unref'd; real network I/O keeps the loop
  // alive, so here a ref'd keep-alive timer stands in for it.
  const fetchImpl = (_url, opts) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 1000)
    opts.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('The operation was aborted')) })
  })
  await assert.rejects(() => fetchWithRetry(fetchImpl, 'u', {}, { retries: 0, timeoutMs: 20 }), /abort/i)
})
