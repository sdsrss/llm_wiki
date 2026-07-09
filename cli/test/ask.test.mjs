import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { askKb } from '../src/ask.mjs'
import { loadLlmConfig } from '../src/llm-config.mjs'

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
