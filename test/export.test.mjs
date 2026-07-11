import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { exportGraph, loadGraph, toGraphML, toCypher, toHtml, wikilinksToMarkdown, exportMarkdownPages } from '../src/export.mjs'

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
  assert.ok(cy.includes('-[r:WIKILINK]->'))
  assert.ok(cy.includes('-[r:SOURCE]->'))
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

test('toHtml embeds the graph, is self-contained, and survives </script> in titles', (t) => {
  const d = seedKb(t)
  const graph = loadGraph(d)
  graph.nodes[0].title = 'evil</script><script>alert(1)'
  const html = toHtml(graph)
  assert.ok(html.includes('<canvas'))
  assert.ok(!html.includes('evil</script>'))          // must be escaped
  assert.ok(!/src\s*=\s*["']https?:/.test(html))      // no external scripts
  assert.ok(!/href\s*=\s*["']https?:/.test(html))     // no external styles
  assert.ok(html.includes('sources/doc'))
})

test('exportGraph html format writes graph.html', (t) => {
  const d = seedKb(t)
  const r = exportGraph(d, { format: 'html' })
  assert.ok(r.out.endsWith('graph.html'))
  assert.ok(fs.readFileSync(r.out, 'utf8').includes('<canvas'))
})

test('exports carry edge confidence: GraphML d4 key, Cypher relationship property', () => {
  const graph = {
    nodes: [{ id: 'a', type: 'entity', title: 'A' }, { id: 'b', type: 'entity', title: 'B' }],
    edges: [
      { source: 'a', target: 'b', type: 'implements', confidence: 'inferred' },
      { source: 'b', target: 'a', type: 'wikilink' }, // legacy edge without confidence
    ],
  }
  const xml = toGraphML(graph)
  assert.match(xml, /<key id="d4" for="edge" attr\.name="confidence" attr\.type="string"\/>/)
  assert.match(xml, /<data key="d3">implements<\/data><data key="d4">inferred<\/data>/)
  assert.ok(!/e1[^]*key="d4"/.test(xml.split('\n').find(l => l.includes('id="e1"'))), 'no d4 data on the edge without confidence')
  const cy = toCypher(graph)
  assert.ok(cy.includes("MERGE (a)-[r:IMPLEMENTS]->(b) SET r.confidence = 'inferred';"))
  assert.ok(cy.includes('MERGE (a)-[r:WIKILINK]->(b);'), 'no SET clause without confidence')
})

test('wikilinksToMarkdown converts plain, aliased, anchored and .md-suffixed links relative to fromDir', () => {
  const body = 'see [[entities/thing]] and [[entities/thing|The Thing]] and [[concepts/idea#h2]] and [[sources/doc.md]] and [[raw/doc.md]]'
  const out = wikilinksToMarkdown(body, 'sources')
  assert.match(out, /\[entities\/thing\]\(\.\.\/entities\/thing\.md\)/)
  assert.match(out, /\[The Thing\]\(\.\.\/entities\/thing\.md\)/)
  assert.match(out, /\[concepts\/idea\]\(\.\.\/concepts\/idea\.md#h2\)/)
  assert.match(out, /\[sources\/doc\]\(doc\.md\)/, 'same-dir link, .md-suffix normalized in label and path')
  assert.match(out, /\[raw\/doc\]\(\.\.\/raw\/doc\.md\)/, 'raw link resolves against the sibling raw/ layer')
  assert.ok(!out.includes('[['), 'no wikilinks remain')
  assert.equal(wikilinksToMarkdown('no links here', ''), 'no links here')
})

test('exportMarkdownPages mirrors the wiki layout with converted links and preserved frontmatter', (t) => {
  const d = seedKb(t)
  const r = exportMarkdownPages(d, {})
  assert.equal(r.out, path.resolve(d, 'wiki-md'))
  assert.equal(r.pageCount, 3, '2 pages + index.md')
  const doc = fs.readFileSync(path.join(d, 'wiki-md/sources/doc.md'), 'utf8')
  assert.match(doc, /\[entities\/thing\]\(\.\.\/entities\/thing\.md\)/)
  assert.match(doc, /^---\ntype: source/, 'frontmatter preserved verbatim')
  const idx = fs.readFileSync(path.join(d, 'wiki-md/index.md'), 'utf8')
  assert.ok(!idx.includes('[['), 'index.md wikilinks converted (root-relative, no ../ prefix)')
  assert.match(idx, /\(sources\/doc\.md\)/)
})
