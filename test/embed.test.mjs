import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { loadLlmConfig } from '../src/llm-config.mjs'
import { embedTexts, embedKb } from '../src/embed.mjs'
import { loadVectorStore } from '../src/vector.mjs'

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
  // invalidate b -> pruned from store
  const b = fs.readFileSync(path.join(d, 'wiki/sources/b.md'), 'utf8')
  fs.writeFileSync(path.join(d, 'wiki/sources/b.md'), b.replace('---\n\n', 'status: invalidated\n---\n\n').replace('tags: [x]', 'tags: [x]\nstatus: invalidated'))
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
