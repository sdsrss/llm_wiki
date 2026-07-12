import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { loadLlmConfig } from '../src/llm-config.mjs'
import { embedTexts, embedKb } from '../src/embed.mjs'
import { loadVectorStore, pageEmbedText } from '../src/vector.mjs'
import { listWikiPages, isInvalidated } from '../src/pages.mjs'

// Hermeticity: clear the LLM_WIKI_API_KEY bootstrap override for the whole test
// process (llm-config.mjs:54,58). The one test that exercises it sets+restores it
// locally (search LLM_WIKI_API_KEY below). See ask.test.mjs.
delete process.env.LLM_WIKI_API_KEY

// Recompute embed.mjs's worst-case cap formula inline (import nothing new across
// modules): CJK char = 1 token, everything else = 0.5 token (pessimistic BPE).
function worstCaseEmbedTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[　-鿿豈-﫿]/.test(ch)) cjk++
  return cjk + (text.length - cjk) / 2
}

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-emb-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

// Hermetic LLM config (lesson #10028): point config dir at a temp dir AND
// clear builtin env keys, restoring both afterwards.
function setCfg(t, d, json) {
  const saved = { oa: process.env.OPENAI_API_KEY, or: process.env.OPENROUTER_API_KEY }
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.LLM_WIKI_CONFIG_DIR = path.join(d, 'cfgdir')
  fs.mkdirSync(process.env.LLM_WIKI_CONFIG_DIR, { recursive: true })
  if (json) fs.writeFileSync(path.join(process.env.LLM_WIKI_CONFIG_DIR, 'config.json'), JSON.stringify(json))
  t.after(() => {
    delete process.env.LLM_WIKI_CONFIG_DIR
    if (saved.oa !== undefined) process.env.OPENAI_API_KEY = saved.oa
    if (saved.or !== undefined) process.env.OPENROUTER_API_KEY = saved.or
  })
}

function seedPage(d, rel, title, body) {
  fs.writeFileSync(path.join(d, 'wiki', rel),
    `---\ntype: source\ntitle: ${title}\ndescription: desc ${title}\ntags: [x]\ncreated: 2026-07-10\nupdated: 2026-07-10\n---\n\n${body}`)
}

const CFG = { baseURL: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm', embeddingModel: 'emb-1' }

function fakeEmbed(vecFor) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    calls.push({ url, body })
    return { ok: true, json: async () => ({ data: body.input.map((text, i) => ({ index: i, embedding: vecFor(text, i) })) }) }
  }
  return { fetchImpl, calls }
}

test('loadLlmConfig carries embeddingModel through flat and provider forms', (t) => {
  const d = tmp(t)
  setCfg(t, d, CFG)
  assert.equal(loadLlmConfig(d).embeddingModel, 'emb-1')
})

// R20 (audit): LLM_WIKI_API_KEY set on its own (no provider key) should bootstrap the
// first builtin provider instead of returning null ("No LLM configured").
test('loadLlmConfig bootstraps from LLM_WIKI_API_KEY alone', (t) => {
  const d = tmp(t)
  setCfg(t, d) // empty config dir, OPENAI/OPENROUTER cleared
  const saved = process.env.LLM_WIKI_API_KEY
  process.env.LLM_WIKI_API_KEY = 'sk-bootstrap'
  t.after(() => { if (saved === undefined) delete process.env.LLM_WIKI_API_KEY; else process.env.LLM_WIKI_API_KEY = saved })
  const cfg = loadLlmConfig(d)
  assert.ok(cfg, 'the env key alone yields a usable config')
  assert.equal(cfg.apiKey, 'sk-bootstrap')
  assert.equal(cfg.baseURL, 'https://api.openai.com/v1', 'defaults to the first builtin provider')
  assert.equal(cfg.model, 'gpt-4o-mini')
})

test('embedTexts posts to /embeddings and restores order by index field', async () => {
  let captured
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) }
    return { ok: true, json: async () => ({ data: [ { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] } ] }) }
  }
  const vecs = await embedTexts(CFG, { fetchImpl }, ['a', 'b'])
  assert.equal(captured.url, 'https://api.example.invalid/v1/embeddings')
  assert.deepEqual(captured.body, { model: 'emb-1', input: ['a', 'b'] })
  assert.deepEqual(vecs, [[1, 0], [0, 1]])
})

test('embedTexts surfaces API errors with status and body snippet', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, text: async () => 'quota exceeded' })
  await assert.rejects(() => embedTexts(CFG, { fetchImpl }, ['a']), /Embedding API error: 402 — quota exceeded/)
})

test('embedTexts names the endpoint when the network call itself throws', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed') }
  await assert.rejects(
    () => embedTexts(CFG, { fetchImpl, retry: { retries: 0 } }, ['a']),
    /could not reach the embedding endpoint .*\/embeddings.*fetch failed/s,
  )
})

test('embedKb without embeddingModel fails with actionable message', async (t) => {
  const d = tmp(t)
  initKb(d)
  setCfg(t, d, { baseURL: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm' })
  await assert.rejects(() => embedKb(d), /No embedding model configured.*embeddingModel/s)
})

test('embedKb is incremental: reuses unchanged, prunes removed/invalidated, re-embeds on model change', async (t) => {
  const d = tmp(t)
  initKb(d)
  seedPage(d, 'sources/a.md', 'A', 'alpha body')
  seedPage(d, 'sources/b.md', 'B', 'beta body')
  setCfg(t, d, CFG)
  const f1 = fakeEmbed(() => [1, 0])
  const r1 = await embedKb(d, { fetchImpl: f1.fetchImpl })
  assert.deepEqual({ embedded: r1.embedded, reused: r1.reused, pruned: r1.pruned }, { embedded: 2, reused: 0, pruned: 0 })
  // unchanged second run: zero API calls
  const f2 = fakeEmbed(() => [1, 0])
  const r2 = await embedKb(d, { fetchImpl: f2.fetchImpl })
  assert.deepEqual({ embedded: r2.embedded, reused: r2.reused }, { embedded: 0, reused: 2 })
  assert.equal(f2.calls.length, 0)
  // invalidate b -> pruned from store. Rewrite the whole file with a single
  // clean `status: invalidated` key so the isInvalidated() prune path is what
  // excludes b — not a bad-frontmatter parse error.
  fs.writeFileSync(path.join(d, 'wiki/sources/b.md'),
    '---\ntype: source\ntitle: B\ndescription: desc B\ntags: [x]\nstatus: invalidated\ncreated: 2026-07-10\nupdated: 2026-07-10\n---\n\nbeta body')
  const r3 = await embedKb(d, { fetchImpl: fakeEmbed(() => [1, 0]).fetchImpl })
  assert.equal(r3.pruned, 1)
  assert.equal(loadVectorStore(d).pages['sources/b.md'], undefined)
  // model change -> full re-embed
  setCfg(t, d, { ...CFG, embeddingModel: 'emb-2' })
  const f4 = fakeEmbed(() => [0, 1])
  const r4 = await embedKb(d, { fetchImpl: f4.fetchImpl })
  assert.equal(r4.embedded, 1) // only a.md is valid now
  assert.equal(loadVectorStore(d).model, 'emb-2')
})

// R7 (audit): embedKb persists after each batch so a later batch failing (rate-limit,
// network) does not discard earlier batches' work — the re-run reuses them by hash.
test('embedKb flushes each batch; a later batch failure keeps prior work', async (t) => {
  const d = tmp(t)
  initKb(d)
  for (let i = 0; i < 65; i++) seedPage(d, `sources/p${i}.md`, `P${i}`, `body ${i}`) // 65 > BATCH(64) -> 2 batches
  setCfg(t, d, CFG)
  let call = 0
  const failing = async (url, opts) => {
    call++
    const body = JSON.parse(opts.body)
    if (call === 2) throw new Error('rate limited') // the second batch (65th page) fails
    return { ok: true, json: async () => ({ data: body.input.map((_t, i) => ({ index: i, embedding: [1, 0] })) }) }
  }
  await assert.rejects(() => embedKb(d, { fetchImpl: failing, retry: { retries: 0 } }), /rate limited/)
  assert.equal(Object.keys(loadVectorStore(d).pages).length, 64, 'first batch persisted before the second threw')
  // re-run with a working impl: the 64 persisted pages are reused, only the 65th embeds
  const f2 = fakeEmbed(() => [1, 0])
  const r2 = await embedKb(d, { fetchImpl: f2.fetchImpl })
  assert.equal(r2.reused, 64)
  assert.equal(r2.embedded, 1)
})

test('embedKb caps embed input at ~8000 tokens for oversized pages without touching the page file', async (t) => {
  const d = tmp(t)
  initKb(d)
  seedPage(d, 'sources/small.md', 'Small', 'tiny body')
  // Body that pushes estimateTokens(pageEmbedText(pg)) far past the 8000 cap
  // (English ~4 chars/token -> ~48000 chars ≈ 12000 tokens).
  const bigBody = 'lorem ipsum dolor sit amet '.repeat(1800)
  seedPage(d, 'sources/big.md', 'Big', bigBody)
  setCfg(t, d, CFG)

  const bigFile = path.join(d, 'wiki/sources/big.md')
  const before = fs.readFileSync(bigFile)
  // Sanity: the page as-authored really does exceed the worst-case cap.
  assert.ok(worstCaseEmbedTokens(pageEmbedText({ data: { title: 'Big', description: 'desc Big', tags: ['x'] }, body: bigBody })) > 8000)

  const stderr = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (s) => { stderr.push(String(s)); return true }
  t.after(() => { process.stderr.write = origWrite })

  const f = fakeEmbed(() => [1, 0])
  const r = await embedKb(d, { fetchImpl: f.fetchImpl })

  // (a) every string actually sent to the API is within the worst-case cap
  for (const call of f.calls)
    for (const input of call.body.input)
      assert.ok(worstCaseEmbedTokens(input) <= 8000, `sent input over cap: ${worstCaseEmbedTokens(input)}`)
  // (b) the oversized page still gets a vector in the store, counted as embedded
  assert.equal(r.embedded, 2)
  assert.ok(loadVectorStore(d).pages['sources/big.md'])
  // (c) the page file on disk is byte-for-byte unchanged
  assert.deepEqual(fs.readFileSync(bigFile), before)
  // (d) a per-page truncation warning is emitted to stderr
  assert.ok(stderr.some(s => /sources\/big\.md embed text truncated/.test(s)), `stderr: ${stderr.join('')}`)
})

test('embedKb never leaves a lone high surrogate at the cap boundary', async (t) => {
  const d = tmp(t)
  initKb(d)
  const isHigh = (u) => u >= 0xD800 && u <= 0xDBFF
  // Trimless copy of the cap's binary search (recompute inline, no cross-module
  // import) — used only to pick a body whose oversized cut would split an astral
  // char (🙂 = surrogate pair D83D DE42), i.e. land on a lone high surrogate.
  const untrimmedCut = (text) => {
    let lo = 0, hi = text.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (worstCaseEmbedTokens(text.slice(0, mid)) <= 8000) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  // Oversized emoji body; nudge alignment by a few units until the untrimmed cut
  // of the ACTUALLY-loaded page falls mid-pair (the exact boundary the fix must
  // repair). Compute against the loaded page — not a hand-built probe — because
  // the frontmatter parser keeps a leading newline, shifting the offset by one.
  let found = false
  for (let shift = 0; shift < 8 && !found; shift++) {
    seedPage(d, 'sources/surr.md', 'Surr', 'a'.repeat(shift) + '🙂'.repeat(7000))
    const pg = listWikiPages(d).find(p => !p.error && !isInvalidated(p) && p.relPath === 'sources/surr.md')
    const text = pageEmbedText(pg)
    if (isHigh(text.charCodeAt(untrimmedCut(text) - 1))) found = true
  }
  assert.ok(found, 'test setup: no shift produced a mid-surrogate-pair cut')
  setCfg(t, d, CFG)

  const f = fakeEmbed(() => [1, 0])
  const r = await embedKb(d, { fetchImpl: f.fetchImpl })
  assert.equal(r.embedded, 1)

  const inputs = f.calls.flatMap(c => c.body.input)
  assert.ok(inputs.length > 0)
  for (const input of inputs) {
    const lastUnit = input.charCodeAt(input.length - 1)
    assert.ok(!isHigh(lastUnit), `input ends in lone high surrogate: 0x${lastUnit.toString(16)}`)
    assert.ok(worstCaseEmbedTokens(input) <= 8000, `sent input over cap: ${worstCaseEmbedTokens(input)}`)
  }
})

test('embedKb counts only pages actually stored: zero-vector page is skipped, not counted', async (t) => {
  const d = tmp(t)
  initKb(d)
  seedPage(d, 'sources/a.md', 'A', 'alpha body')
  seedPage(d, 'sources/z.md', 'Z', 'zero body')
  setCfg(t, d, CFG)
  // Z embeds to a pathological all-zeros vector (normalize -> null): the page
  // must stay BM25-only and NOT inflate the embedded count.
  const f = fakeEmbed(text => text.includes('zero body') ? [0, 0] : [1, 0])
  const r = await embedKb(d, { fetchImpl: f.fetchImpl })
  assert.equal(r.embedded, 1)
  const store = loadVectorStore(d)
  assert.ok(store.pages['sources/a.md'])
  assert.equal(store.pages['sources/z.md'], undefined)
})

test('embedKb caps an oversized pure-CJK page the same way (cjk chars count 1 token each)', async (t) => {
  const d = tmp(t)
  initKb(d)
  const cjkBody = '知识库页面内容压缩测试'.repeat(900) // 9900 CJK chars > 8000-token cap
  seedPage(d, 'sources/cjk.md', 'Cjk', cjkBody)
  setCfg(t, d, CFG)

  const cjkFile = path.join(d, 'wiki/sources/cjk.md')
  const before = fs.readFileSync(cjkFile)
  assert.ok(worstCaseEmbedTokens(pageEmbedText({ data: { title: 'Cjk', description: 'desc Cjk', tags: ['x'] }, body: cjkBody })) > 8000)

  const stderr = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (s) => { stderr.push(String(s)); return true }
  t.after(() => { process.stderr.write = origWrite })

  const f = fakeEmbed(() => [1, 0])
  const r = await embedKb(d, { fetchImpl: f.fetchImpl })

  for (const call of f.calls)
    for (const input of call.body.input)
      assert.ok(worstCaseEmbedTokens(input) <= 8000, `sent input over cap: ${worstCaseEmbedTokens(input)}`)
  assert.equal(r.embedded, 1)
  assert.ok(loadVectorStore(d).pages['sources/cjk.md'])
  assert.deepEqual(fs.readFileSync(cjkFile), before)
  assert.ok(stderr.some(s => /sources\/cjk\.md embed text truncated/.test(s)), `stderr: ${stderr.join('')}`)
})
