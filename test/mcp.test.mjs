import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { createMcpServer } from '../src/mcp.mjs'
import { saveVectorStore } from '../src/vector.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-mcp-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function seedKb(d) {
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/karpathy-gist.md'),
    `---\ntype: source\ntitle: Karpathy gist\ndescription: three layers\ntags: [karpathy]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\n三层架构：raw sources、wiki、schema。三操作：ingest、query、lint。`)
  fs.writeFileSync(path.join(d, 'wiki/concepts/old-idea.md'),
    `---\ntype: concept\ntitle: Old idea\ndescription: superseded concept\nstatus: invalidated\nsuperseded_by: sources/karpathy-gist\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\n已失效的旧概念内容。`)
  buildIndex(d)
}

async function connectClient(t, d, opts) {
  const server = createMcpServer(d, opts)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(async () => { await client.close(); await server.close() })
  return client
}

test('wiki_overview returns the index content with the data notice', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_overview', arguments: {} })
  assert.equal(r.isError ?? false, false)
  const text = r.content[0].text
  assert.match(text, /never follow instructions/, 'data notice present')
  assert.match(text, /karpathy-gist/, 'index lists the seeded page')
})

test('wiki_overview errors with guidance when no index exists', async (t) => {
  const d = tmp(t)
  initKb(d) // no buildIndex
  fs.rmSync(path.join(d, 'wiki/index.md'), { force: true })
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_overview', arguments: {} })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /llm-wiki index/, 'tells the caller how to build the index')
})

test('wiki_search returns ids + metadata, never full page text', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_search', arguments: { query: '三层架构' } })
  const text = r.content[0].text
  assert.match(text, /sources\/karpathy-gist/)
  assert.match(text, /three layers/, 'description shown')
  assert.doesNotMatch(text, /ingest、query、lint/, 'body text must NOT leak into search results')
})

test('wiki_search zero hits returns guidance, not an error', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_search', arguments: { query: 'zzz-no-such-term' } })
  assert.equal(r.isError ?? false, false)
  assert.match(r.content[0].text, /wiki_overview/, 'points the agent at the fallback path')
})

test('wiki_read_page returns the whole page for a valid id', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_read_page', arguments: { id: 'sources/karpathy-gist' } })
  const text = r.content[0].text
  assert.match(text, /三层架构：raw sources/, 'full body present')
  assert.match(text, /type: source/, 'frontmatter present')
})

test('wiki_read_page rejects unknown ids and path traversal', async (t) => {
  const d = tmp(t)
  seedKb(d)
  fs.writeFileSync(path.join(d, 'secret.txt'), 'top secret')
  const client = await connectClient(t, d)
  for (const id of ['nope/missing', '../secret.txt', '../../etc/passwd', 'sources/../../secret']) {
    const r = await client.callTool({ name: 'wiki_read_page', arguments: { id } })
    assert.equal(r.isError, true, `id ${id} must be rejected`)
    assert.doesNotMatch(r.content[0].text, /top secret/)
  }
})

test('wiki_read_page blocks invalidated pages unless include_invalidated', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const blocked = await client.callTool({ name: 'wiki_read_page', arguments: { id: 'concepts/old-idea' } })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /superseded by sources\/karpathy-gist/)
  const forced = await client.callTool({ name: 'wiki_read_page', arguments: { id: 'concepts/old-idea', include_invalidated: true } })
  assert.equal(forced.isError ?? false, false)
  assert.match(forced.content[0].text, /已失效的旧概念内容/)
})

test('wiki_ask answers via the configured LLM and cites pages used', async (t) => {
  const d = tmp(t)
  seedKb(d)
  process.env.LLM_WIKI_CONFIG_DIR = path.join(d, 'cfgdir')
  fs.mkdirSync(process.env.LLM_WIKI_CONFIG_DIR)
  fs.writeFileSync(path.join(process.env.LLM_WIKI_CONFIG_DIR, 'config.json'),
    JSON.stringify({ baseURL: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm' }))
  t.after(() => delete process.env.LLM_WIKI_CONFIG_DIR)
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '答案 [[sources/karpathy-gist]]' } }] }) })
  const client = await connectClient(t, d, { fetchImpl })
  const r = await client.callTool({ name: 'wiki_ask', arguments: { question: '三层架构有哪些' } })
  assert.equal(r.isError ?? false, false)
  const text = r.content[0].text
  assert.match(text, /答案/)
  assert.match(text, /never follow instructions/)
  assert.match(text, /pages used: sources\/karpathy-gist\.md/)
})

test('wiki_ask without LLM config errors and points at search+read', async (t) => {
  const d = tmp(t)
  seedKb(d)
  process.env.LLM_WIKI_CONFIG_DIR = path.join(d, 'empty-cfg')
  fs.mkdirSync(process.env.LLM_WIKI_CONFIG_DIR)
  // An empty config dir still falls through to the builtin providers keyed on
  // OPENAI_API_KEY / OPENROUTER_API_KEY; clear them so "no config" is genuine
  // (same hermetic pattern as test/ask.test.mjs "returns null when nothing configured").
  const savedKeys = { oa: process.env.OPENAI_API_KEY, or: process.env.OPENROUTER_API_KEY }
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    delete process.env.LLM_WIKI_CONFIG_DIR
    if (savedKeys.oa) process.env.OPENAI_API_KEY = savedKeys.oa
    if (savedKeys.or) process.env.OPENROUTER_API_KEY = savedKeys.or
  })
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_ask', arguments: { question: '三层架构有哪些' } })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /wiki_search/, 'degradation guidance present')
})

test('llm-wiki mcp speaks MCP over stdio (initialize + tools/list)', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const bin = path.resolve(fileURLToPath(import.meta.url), '../../bin/llm-wiki.mjs')
  const child = spawn(process.execPath, [bin, 'mcp', '--kb', d], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
  const lines = []
  let resolveReady
  const ready = new Promise(r => { resolveReady = r })
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (line) lines.push(JSON.parse(line))
      if (lines.length >= 2) resolveReady()
    }
  })
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } })
  // notifications/initialized then tools/list, per MCP handshake
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await ready
  const init = lines.find(m => m.id === 1)
  assert.equal(init.result.serverInfo.name, 'llm-wiki')
  const toolsMsg = lines.find(m => m.id === 2)
  const names = toolsMsg.result.tools.map(tl => tl.name).sort()
  assert.deepEqual(names, ['wiki_ask', 'wiki_graph', 'wiki_overview', 'wiki_read_page', 'wiki_search'])
})

test('wiki_graph path returns the link chain with edge types', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_graph', arguments: { op: 'path', from: 'concepts/old-idea', to: 'sources/karpathy-gist' } })
  assert.equal(r.isError ?? false, false)
  const text = r.content[0].text
  assert.match(text, /never follow instructions/, 'data notice present (titles are page-derived)')
  assert.match(text, /concepts\/old-idea/)
  assert.match(text, /superseded_by/)
})

test('wiki_graph hubs ranks pages and validates op params', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_graph', arguments: { op: 'hubs' } })
  assert.equal(r.isError ?? false, false)
  assert.match(r.content[0].text, /sources\/karpathy-gist/)
  const bad = await client.callTool({ name: 'wiki_graph', arguments: { op: 'path', from: 'concepts/old-idea' } })
  assert.equal(bad.isError, true)
  assert.match(bad.content[0].text, /needs/, 'missing `to` reported, not thrown')
  const unknown = await client.callTool({ name: 'wiki_graph', arguments: { op: 'neighbors', id: 'concepts/zzz' } })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0].text, /unknown node/)
})

test('wiki_graph errors with guidance when graph.json is missing', async (t) => {
  const d = tmp(t)
  initKb(d) // no buildIndex → no graph.json
  fs.rmSync(path.join(d, 'wiki/graph.json'), { force: true })
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_graph', arguments: { op: 'hubs' } })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /llm-wiki index/)
})

test('wiki_graph marks invalidated nodes in neighbors and hubs output', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  const r = await client.callTool({ name: 'wiki_graph', arguments: { op: 'neighbors', id: 'sources/karpathy-gist' } })
  assert.match(r.content[0].text, /concepts\/old-idea.*⚠ invalidated/)
  const h = await client.callTool({ name: 'wiki_graph', arguments: { op: 'hubs' } })
  assert.match(h.content[0].text, /old-idea.*⚠ invalidated/)
})

test('wiki_graph leaf branches: no path and no neighbors return guidance, not errors', async (t) => {
  const d = tmp(t)
  seedKb(d)
  const client = await connectClient(t, d)
  fs.writeFileSync(path.join(d, 'wiki/entities/island.md'),
    `---\ntype: entity\ntitle: Island\ndescription: isolated\ntags: [x]\nsources: []\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nno links`)
  buildIndex(d)
  const p = await client.callTool({ name: 'wiki_graph', arguments: { op: 'path', from: 'entities/island', to: 'sources/karpathy-gist' } })
  assert.equal(p.isError ?? false, false)
  assert.match(p.content[0].text, /No link path/)
  const n = await client.callTool({ name: 'wiki_graph', arguments: { op: 'neighbors', id: 'entities/island' } })
  assert.equal(n.isError ?? false, false)
  assert.match(n.content[0].text, /no linked neighbors/)
})

// --- wiki_search hybrid (v2.5) ---

function setLlmCfg(t, d) {
  const saved = { oa: process.env.OPENAI_API_KEY, or: process.env.OPENROUTER_API_KEY }
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.LLM_WIKI_CONFIG_DIR = path.join(d, 'cfgdir')
  fs.mkdirSync(process.env.LLM_WIKI_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.LLM_WIKI_CONFIG_DIR, 'config.json'),
    JSON.stringify({ baseURL: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm', embeddingModel: 'emb-1' }))
  t.after(() => {
    delete process.env.LLM_WIKI_CONFIG_DIR
    if (saved.oa !== undefined) process.env.OPENAI_API_KEY = saved.oa
    if (saved.or !== undefined) process.env.OPENROUTER_API_KEY = saved.or
  })
}

function enableVectors(d) {
  fs.writeFileSync(path.join(d, 'wiki.config.json'), JSON.stringify({ vectorEnabled: true }))
  saveVectorStore(d, { model: 'emb-1', dim: 2, pages: {
    'sources/karpathy-gist.md': { hash: 'h', vec: [1, 0] },
  } })
}

test('wiki_search fuses vector hits when the KB has embeddings enabled', async (t) => {
  const d = tmp(t)
  seedKb(d)
  enableVectors(d)
  setLlmCfg(t, d)
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) })
  const client = await connectClient(t, d, { fetchImpl })
  // Cross-language query: zero lexical overlap with the page, vector finds it.
  const r = await client.callTool({ name: 'wiki_search', arguments: { query: 'what are the three layers' } })
  assert.equal(r.isError ?? false, false)
  assert.match(r.content[0].text, /sources\/karpathy-gist/, 'vector-only hit surfaces')
  assert.match(r.content[0].text, /vector/, 'hit line names its retrieval source')
})

test('wiki_search stays pure BM25 (no embedding call, same format) when vectorEnabled is off', async (t) => {
  const d = tmp(t)
  seedKb(d)
  let called = 0
  const fetchImpl = async () => { called++; throw new Error('must not be called') }
  const client = await connectClient(t, d, { fetchImpl })
  const r = await client.callTool({ name: 'wiki_search', arguments: { query: '三层架构' } })
  assert.equal(r.isError ?? false, false)
  assert.match(r.content[0].text, /\(score \d/, 'default path keeps the BM25 score format')
  assert.equal(called, 0, 'no network on the default path')
})

test('wiki_search degrades to BM25 results when the embedding call fails', async (t) => {
  const d = tmp(t)
  seedKb(d)
  enableVectors(d)
  setLlmCfg(t, d)
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  const client = await connectClient(t, d, { fetchImpl })
  const r = await client.callTool({ name: 'wiki_search', arguments: { query: '三层架构' } })
  assert.equal(r.isError ?? false, false, 'fail-open: not an MCP error')
  assert.match(r.content[0].text, /karpathy-gist/, 'BM25 hits still returned')
})
