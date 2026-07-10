import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { exportGraph, loadGraph, toGraphML, toCypher } from '../src/export.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function seedKb(t) {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/doc.md'), 'raw')
  fs.writeFileSync(path.join(d, 'wiki/sources/doc.md'),
    `---\ntype: source\ntitle: Doc "quoted" & <tagged>\ndescription: d\ntags: [x]\nsources: [raw/doc.md]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody [[entities/thing]]`)
  fs.writeFileSync(path.join(d, 'wiki/entities/thing.md'),
    `---\ntype: entity\ntitle: It's a thing\ndescription: d\ntags: [x]\nsources: [raw/doc.md]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody`)
  buildIndex(d)
  return d
}

test('loadGraph synthesizes raw nodes for source-edge targets', (t) => {
  const d = seedKb(t)
  const g = loadGraph(d)
  const rawNode = g.nodes.find(n => n.id === 'raw/doc.md')
  assert.equal(rawNode.type, 'raw')
  const ids = new Set(g.nodes.map(n => n.id))
  for (const e of g.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `dangling edge ${e.source} -> ${e.target}`)
  }
})

test('toGraphML escapes XML and carries node/edge attributes', (t) => {
  const d = seedKb(t)
  const xml = toGraphML(loadGraph(d))
  assert.ok(xml.startsWith('<?xml'))
  assert.ok(xml.includes('&quot;quoted&quot; &amp; &lt;tagged&gt;'))
  assert.ok(xml.includes('<data key="d3">wikilink</data>'))
  assert.ok(!/<data key="d1">[^<]*"/.test(xml))
})

test('toCypher escapes quotes and emits MERGE statements', (t) => {
  const d = seedKb(t)
  const cy = toCypher(loadGraph(d))
  assert.ok(cy.includes("MERGE (n:Source {id: 'sources/doc'})"))
  assert.ok(cy.includes("It\\'s a thing"))
  assert.ok(cy.includes('-[:WIKILINK]->'))
  assert.ok(cy.includes('-[:SOURCE]->'))
})

test('exportGraph writes the requested format and rejects unknown formats', (t) => {
  const d = seedKb(t)
  const r = exportGraph(d, { format: 'graphml' })
  assert.ok(fs.existsSync(path.join(d, 'graph.graphml')))
  assert.ok(r.nodeCount >= 3)
  assert.throws(() => exportGraph(d, { format: 'dot' }), /unknown format/)
})

test('exportGraph errors helpfully when graph.json is missing', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.rmSync(path.join(d, 'wiki/graph.json'), { force: true })
  assert.throws(() => exportGraph(d, { format: 'cypher' }), /llm-wiki index/)
})
