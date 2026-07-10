import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { askKb, retrievePages } from '../src/ask.mjs'
import { loadLlmConfig, makeTransport } from '../src/llm-config.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function seedKb(d) {
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/karpathy-gist.md'),
    `---\ntype: source\ntitle: Karpathy gist\ndescription: three layers\ntags: [karpathy]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\n三层架构：raw sources、wiki、schema。三操作：ingest、query、lint。`)
  fs.writeFileSync(path.join(d, 'wiki/sources/other.md'),
    `---\ntype: source\ntitle: Other\ndescription: unrelated\ntags: [db]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\n数据库索引优化与查询计划。`)
  buildIndex(d)
}

test('retrieveOnly returns ranked pages without calling the LLM', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const r = await askKb(d, '三层架构有哪些', { retrieveOnly: true })
  assert.equal(r.answer, null)
  assert.equal(r.pages[0].relPath, 'sources/karpathy-gist.md')
})

test('askKb sends full pages to the LLM and returns answer', async (t) => {
  const d = tmp(t)
  seedKb(d)
  process.env.LLM_WIKI_CONFIG_DIR = path.join(d, 'cfgdir')
  fs.mkdirSync(process.env.LLM_WIKI_CONFIG_DIR)
  fs.writeFileSync(path.join(process.env.LLM_WIKI_CONFIG_DIR, 'config.json'),
    JSON.stringify({ baseURL: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm' }))
  t.after(() => delete process.env.LLM_WIKI_CONFIG_DIR)
  let captured
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '答案 [[sources/karpathy-gist]]' } }] }) }
  }
  const r = await askKb(d, '三层架构有哪些', { fetchImpl })
  assert.match(r.answer, /karpathy-gist/)
  assert.equal(captured.url, 'https://api.example.invalid/v1/chat/completions')
  const prompt = captured.body.messages.map(m => m.content).join('\n')
  assert.match(prompt, /三层架构：raw sources/, 'full page text must be in the prompt')
})

test('askKb rejects when retrieval finds no pages', async (t) => {
  const d = tmp(t)
  initKb(d)
  buildIndex(d)
  await assert.rejects(
    () => askKb(d, 'anything at all', {}),
    /No relevant pages found/,
  )
})

function llmEnv(t, d) {
  process.env.LLM_WIKI_CONFIG_DIR = path.join(d, 'cfgdir')
  fs.mkdirSync(process.env.LLM_WIKI_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.LLM_WIKI_CONFIG_DIR, 'config.json'),
    JSON.stringify({ baseURL: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm' }))
  t.after(() => delete process.env.LLM_WIKI_CONFIG_DIR)
}

test('askKb surfaces the error body on non-ok responses', async (t) => {
  const d = tmp(t)
  seedKb(d)
  llmEnv(t, d)
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '{"error":{"message":"rate limited, retry later"}}' })
  await assert.rejects(() => askKb(d, '三层架构有哪些', { fetchImpl }), /429.*rate limited/s)
})

test('askKb rejects with a clear error on unexpected 200 response shapes', async (t) => {
  const d = tmp(t)
  seedKb(d)
  llmEnv(t, d)
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { message: 'quota exceeded' } }) })
  await assert.rejects(() => askKb(d, '三层架构有哪些', { fetchImpl }), /unexpected response shape.*quota exceeded/s)
})

test('askKb drops lowest-ranked whole pages when over the token budget', async (t) => {
  const d = tmp(t)
  initKb(d)
  const page = (name, extra) => fs.writeFileSync(path.join(d, `wiki/sources/${name}.md`),
    `---\ntype: source\ntitle: alpha protocol ${name}\ndescription: alpha protocol notes\ntags: [alpha]\nsources: [raw/a.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nalpha protocol ${extra} ${'filler words here '.repeat(30)}`)
  page('first', 'primary primary primary alpha protocol alpha protocol')
  page('second', 'secondary')
  buildIndex(d)
  fs.writeFileSync(path.join(d, 'wiki.config.json'), JSON.stringify({ askTokenBudget: 40 }))
  llmEnv(t, d)
  let captured
  const fetchImpl = async (_url, opts) => {
    captured = JSON.parse(opts.body)
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  const r = await askKb(d, 'alpha protocol', { fetchImpl })
  assert.equal(r.pages.length, 1, 'only the top page fits the 40-token budget')
  assert.deepEqual(r.trimmed, ['sources/second.md'])
  const prompt = captured.messages.map(m => m.content).join('\n')
  assert.ok(!prompt.includes('alpha protocol secondary'), 'trimmed page body must not reach the prompt')
})

test('token budget cuts at the first overflow — no greedy backfill with smaller pages', async (t) => {
  const d = tmp(t)
  initKb(d)
  const page = (name, body) => fs.writeFileSync(path.join(d, `wiki/sources/${name}.md`),
    `---\ntype: source\ntitle: Neutral ${name}\ndescription: neutral notes\ntags: [n]\nsources: [raw/a.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\n${body}`)
  // Deterministic BM25 order despite rank2's length penalty:
  // rank1 matches both query terms tf=6 in a short doc, rank2 both terms tf=4
  // in a long doc, rank3 one term tf=1 in a short doc.
  page('rank1', 'alphaterm betaterm '.repeat(6) + 'first')
  page('rank2', 'alphaterm betaterm '.repeat(4) + 'middle ' + 'filler words here '.repeat(200))
  page('rank3', 'betaterm third')
  buildIndex(d)
  fs.writeFileSync(path.join(d, 'wiki.config.json'), JSON.stringify({ askTokenBudget: 120 }))
  llmEnv(t, d)
  let captured
  const fetchImpl = async (_url, opts) => {
    captured = JSON.parse(opts.body)
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  const r = await askKb(d, 'alphaterm betaterm', { fetchImpl })
  assert.deepEqual(r.pages.map(h => h.relPath), ['sources/rank1.md'],
    'rank2 overflows the budget, and rank3 must NOT slip in behind it despite fitting')
  assert.deepEqual(r.trimmed, ['sources/rank2.md', 'sources/rank3.md'])
  const prompt = captured.messages.map(m => m.content).join('\n')
  assert.ok(!prompt.includes('third'), 'rank3 body must not reach the prompt')
})

test('loadLlmConfig: providers form picks first provider with env key set', (t) => {
  const d = tmp(t)
  initKb(d)
  const cfgDir = path.join(d, 'cfgdir2')
  fs.mkdirSync(cfgDir)
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    priority: ['openai', 'openrouter'],
    providers: {
      openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'TEST_OPENAI_KEY', model: 'gpt-4o-mini' },
      openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'TEST_OPENROUTER_KEY', model: 'anthropic/claude-sonnet-5' },
    },
  }))
  process.env.LLM_WIKI_CONFIG_DIR = cfgDir
  process.env.TEST_OPENROUTER_KEY = 'or-key'
  delete process.env.TEST_OPENAI_KEY
  t.after(() => { delete process.env.LLM_WIKI_CONFIG_DIR; delete process.env.TEST_OPENROUTER_KEY; delete process.env.TEST_OPENAI_KEY })
  const cfg1 = loadLlmConfig(d)
  assert.equal(cfg1.model, 'anthropic/claude-sonnet-5')
  assert.equal(cfg1.apiKey, 'or-key')
  process.env.TEST_OPENAI_KEY = 'oa-key'
  const cfg2 = loadLlmConfig(d)
  assert.equal(cfg2.model, 'gpt-4o-mini', 'openai wins when both keys set (priority order)')
  assert.equal(cfg2.apiKey, 'oa-key')
})

test('loadLlmConfig: kb llm override is restricted to model unless explicitly allowed', (t) => {
  const d = tmp(t)
  initKb(d)
  const cfgDir = path.join(d, 'cfgdir-sec')
  fs.mkdirSync(cfgDir)
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    priority: ['openai'],
    providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'TEST_SEC_KEY', model: 'gpt-4o-mini' } },
  }))
  fs.writeFileSync(path.join(d, 'wiki.config.json'),
    JSON.stringify({ llm: { baseURL: 'https://evil.example/v1', model: 'kb-model' } }))
  process.env.LLM_WIKI_CONFIG_DIR = cfgDir
  process.env.TEST_SEC_KEY = 'sec-key'
  const savedAllow = process.env.LLM_WIKI_ALLOW_KB_LLM_OVERRIDE
  delete process.env.LLM_WIKI_ALLOW_KB_LLM_OVERRIDE
  const writes = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (s) => { writes.push(String(s)); return true }
  t.after(() => {
    process.stderr.write = origWrite
    delete process.env.LLM_WIKI_CONFIG_DIR
    delete process.env.TEST_SEC_KEY
    if (savedAllow === undefined) delete process.env.LLM_WIKI_ALLOW_KB_LLM_OVERRIDE
    else process.env.LLM_WIKI_ALLOW_KB_LLM_OVERRIDE = savedAllow
  })
  const cfg = loadLlmConfig(d)
  assert.equal(cfg.baseURL, 'https://api.openai.com/v1', 'kb must not redirect baseURL')
  assert.equal(cfg.model, 'kb-model', 'kb may still pick the model name')
  assert.equal(cfg.apiKey, 'sec-key')
  assert.ok(writes.some(w => w.includes('ignoring kb-level llm.baseURL')), 'warns about the ignored override')
  process.env.LLM_WIKI_ALLOW_KB_LLM_OVERRIDE = '1'
  const allowed = loadLlmConfig(d)
  assert.equal(allowed.baseURL, 'https://evil.example/v1', 'opt-in restores the full merge')
})

test('loadLlmConfig returns null when nothing configured', (t) => {
  const d = tmp(t)
  initKb(d)
  process.env.LLM_WIKI_CONFIG_DIR = path.join(d, 'nope')
  const saved = { oa: process.env.OPENAI_API_KEY, or: process.env.OPENROUTER_API_KEY }
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    delete process.env.LLM_WIKI_CONFIG_DIR
    if (saved.oa) process.env.OPENAI_API_KEY = saved.oa
    if (saved.or) process.env.OPENROUTER_API_KEY = saved.or
  })
  assert.equal(loadLlmConfig(d), null)
})

test('retrievePages excludes invalidated pages', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/entities/alpha.md'),
    `---\ntype: entity\ntitle: Alpha protocol\ndescription: current alpha protocol page\ntags: [alpha]\nsources: []\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nalpha protocol details`)
  fs.writeFileSync(path.join(d, 'wiki/entities/alpha-old.md'),
    `---\ntype: entity\ntitle: Alpha protocol legacy\ndescription: obsolete alpha protocol page\ntags: [alpha]\nsources: []\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: invalidated\ninvalidated: 2026-07-09\nsuperseded_by: entities/alpha\n---\n\nalpha protocol details legacy`)
  const hits = retrievePages(d, 'alpha protocol', 6)
  assert.ok(hits.some(h => h.relPath === 'entities/alpha.md'))
  assert.ok(!hits.some(h => h.relPath === 'entities/alpha-old.md'))
})

test('makeTransport: global fetch without proxy, undici fetch + dispatcher with proxy', async (t) => {
  const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  const saved = Object.fromEntries(PROXY_VARS.map(v => [v, process.env[v]]))
  t.after(() => {
    for (const v of PROXY_VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
    }
  })
  for (const v of PROXY_VARS) delete process.env[v]
  const bare = await makeTransport()
  assert.equal(bare.fetchImpl, globalThis.fetch)
  assert.equal(bare.dispatcher, undefined)
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
  const proxied = await makeTransport()
  assert.notEqual(proxied.fetchImpl, globalThis.fetch, 'proxy transport must use undici fetch, not built-in fetch')
  assert.equal(typeof proxied.fetchImpl, 'function')
  assert.ok(proxied.dispatcher, 'dispatcher instance expected when proxy env is set')
  assert.equal(typeof proxied.dispatcher.dispatch, 'function')
  await proxied.dispatcher.close()
})
