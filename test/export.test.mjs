import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { exportGraph, loadGraph, toGraphML, toCypher, toHtml, toCanvas, wikilinksToMarkdown, exportMarkdownPages } from '../src/export.mjs'

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
  assert.match(wikilinksToMarkdown('x [[#h]]', 'sources'), /\[h\]\(#h\)/, 'anchor-only link points at the same-page heading')
  assert.match(wikilinksToMarkdown('x [[#h|see]]', 'sources'), /\[see\]\(#h\)/, 'anchor-only link keeps its alias')
  assert.match(wikilinksToMarkdown('x [[entities/thing|]]', 'sources'), /\[entities\/thing\]\(\.\.\/entities\/thing\.md\)/, 'empty alias falls back to target label')
  assert.equal(wikilinksToMarkdown('x [[]] y', 'sources'), 'x [[]] y', 'degenerate empty wikilink left untouched')
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

test('exportMarkdownPages marker-guards a clean re-export and refuses foreign non-empty dirs', (t) => {
  const d = seedKb(t)
  const r1 = exportMarkdownPages(d, {})
  const marker = path.join(r1.out, '.llm-wiki-export')
  assert.ok(fs.existsSync(marker), 'marker written on first export')
  assert.ok(fs.existsSync(path.join(r1.out, 'entities/thing.md')), 'entity page present after first export')
  // delete a wiki page, then re-export: its stale converted copy must be gone
  fs.rmSync(path.join(d, 'wiki/entities/thing.md'))
  exportMarkdownPages(d, {})
  assert.ok(!fs.existsSync(path.join(r1.out, 'entities/thing.md')), 'stale converted page removed on re-export')
  assert.ok(fs.existsSync(marker), 'marker present after re-export')
  // refuse to overwrite a non-empty dir that is not an llm-wiki export dir
  const stray = path.join(d, 'foreign-out')
  fs.mkdirSync(stray, { recursive: true })
  fs.writeFileSync(path.join(stray, 'keep.md'), 'x')
  assert.throws(() => exportMarkdownPages(d, { out: stray }), /refusing to overwrite non-empty/)
  assert.ok(fs.existsSync(path.join(stray, 'keep.md')), 'foreign file left untouched')
})

test('export marker carries provenance and --out pointing at a file errors clearly', (t) => {
  const d = seedKb(t)
  exportMarkdownPages(d, {})
  const marker = JSON.parse(fs.readFileSync(path.join(d, 'wiki-md/.llm-wiki-export'), 'utf8'))
  assert.equal(marker.tool, '@sdsrs/llm-wiki')
  assert.ok(marker.version)
  const f = path.join(d, 'somefile')
  fs.writeFileSync(f, 'x')
  assert.throws(() => exportMarkdownPages(d, { out: f }), /--out must be a directory/)
})

test('exportMarkdownPages refuses --out pointing at the KB root or managed layers', (t) => {
  const d = seedKb(t)
  assert.throws(() => exportMarkdownPages(d, { out: path.join(d, 'raw') }), /managed layers/, 'refuses the immutable raw/ layer')
  assert.throws(() => exportMarkdownPages(d, { out: path.join(d, 'wiki') }), /managed layers/, 'refuses the wiki/ layer')
  assert.throws(() => exportMarkdownPages(d, { out: d }), /managed layers/, 'refuses the KB root itself')
  // raw/ untouched — no marker leaked into it
  assert.ok(!fs.existsSync(path.join(d, 'raw/.llm-wiki-export')), 'no export marker leaked into raw/')
})

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'llm-wiki.mjs')

// Hand-built graph exercising every node type, a raw endpoint, degree ordering,
// and an invalidated node — independent of any KB on disk.
function fixtureGraph() {
  return {
    nodes: [
      { id: 'sources/a', type: 'source', title: 'A' },
      { id: 'entities/b', type: 'entity', title: 'B' },
      { id: 'concepts/hi', type: 'concept', title: 'Hi' },   // degree 2
      { id: 'concepts/lo', type: 'concept', title: 'Lo' },   // degree 1
      { id: 'concepts/dead', type: 'concept', title: 'Dead', status: 'invalidated' },
      { id: 'comparisons/c', type: 'comparison', title: 'C' },
      { id: 'raw/doc.md', type: 'raw', title: 'doc.md' },
    ],
    edges: [
      { source: 'sources/a', target: 'raw/doc.md', type: 'source' },
      { source: 'sources/a', target: 'concepts/hi', type: 'wikilink' },
      { source: 'concepts/hi', target: 'concepts/lo', type: 'wikilink' },
      { source: 'entities/b', target: 'nowhere/x', type: 'wikilink' }, // dangling: dropped
    ],
  }
}

test('toCanvas: file cards, type colors, integer column layout', () => {
  const canvas = JSON.parse(toCanvas(fixtureGraph()))
  const byId = new Map(canvas.nodes.map(n => [n.id, n]))

  // file mapping: raw ids verbatim, wiki ids -> wiki/<id>.md
  assert.equal(byId.get('raw/doc.md').file, 'raw/doc.md')
  assert.equal(byId.get('concepts/hi').file, 'wiki/concepts/hi.md')
  // every node is a file card with integer geometry
  for (const n of canvas.nodes) {
    assert.equal(n.type, 'file')
    for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(n[k]), `${n.id}.${k} integer`)
    assert.equal(n.width, 260)
    assert.equal(n.height, 60)
  }
  // colors: source 5 / entity 4 / concept 6 / comparison 2; raw none; invalidated 1
  assert.equal(byId.get('sources/a').color, '5')
  assert.equal(byId.get('entities/b').color, '4')
  assert.equal(byId.get('concepts/hi').color, '6')
  assert.equal(byId.get('comparisons/c').color, '2')
  assert.equal('color' in byId.get('raw/doc.md'), false)
  assert.equal(byId.get('concepts/dead').color, '1') // invalidated overrides concept color

  // columns by type order: source(0) entity(1) concept(2) comparison(3) raw(4)
  assert.equal(byId.get('sources/a').x, 0)
  assert.equal(byId.get('entities/b').x, 340)
  assert.equal(byId.get('concepts/hi').x, 680)
  assert.equal(byId.get('comparisons/c').x, 1020)
  assert.equal(byId.get('raw/doc.md').x, 1360)

  // within the concept column, higher degree (hi:2) sits above lower (lo:1)
  assert.ok(byId.get('concepts/hi').y < byId.get('concepts/lo').y)
  assert.equal(byId.get('concepts/hi').y, 0)
})

test('toCanvas: edges carry type labels; dangling edges dropped', () => {
  const canvas = JSON.parse(toCanvas(fixtureGraph()))
  assert.equal(canvas.edges.length, 3) // the nowhere/x edge is dropped
  const e = canvas.edges.find(x => x.fromNode === 'sources/a' && x.toNode === 'concepts/hi')
  assert.equal(e.label, 'wikilink')
  assert.ok(e.id) // every edge has an id
  assert.ok(!canvas.edges.some(x => x.toNode === 'nowhere/x'))
})

test('exportGraph writes graph.canvas with .canvas extension and valid JSON', (t) => {
  const d = seedKb(t)
  const r = exportGraph(d, { format: 'canvas' })
  assert.ok(r.out.endsWith('graph.canvas'))
  const canvas = JSON.parse(fs.readFileSync(r.out, 'utf8'))
  assert.equal(canvas.nodes.length, r.nodeCount)
  assert.ok(canvas.nodes.every(n => n.type === 'file'))
  // seedKb's source page maps to a wiki/ file card
  assert.ok(canvas.nodes.some(n => n.file === 'wiki/sources/doc.md'))
})

test('export CLI accepts --format canvas', (t) => {
  const d = seedKb(t)
  const r = spawnSync(process.execPath, [BIN, 'export', '--kb', d, '--format', 'canvas'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /exported \d+ nodes \/ \d+ edges -> .*graph\.canvas/)
  assert.ok(fs.existsSync(path.join(d, 'graph.canvas')))
})
