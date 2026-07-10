import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { createMcpServer } from '../src/mcp.mjs'

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
