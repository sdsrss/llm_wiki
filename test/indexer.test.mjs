import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { buildIndex, extractWikilinks } from '../src/indexer.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function page(type, title, extra = '', sources = "sources: [raw/a.md]\n") {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: desc of ${title}\ntags: [t]\n${type === 'source' ? '' : sources}created: 2026-07-09\nupdated: 2026-07-09\n---\n\n${extra}\n`
}

test('extractWikilinks normalizes targets', () => {
  const links = extractWikilinks('see [[entities/karpathy]] and [[concepts/llm-wiki.md|alias]] and [[entities/karpathy#h2]]')
  assert.deepEqual(links, ['entities/karpathy', 'concepts/llm-wiki'])
})

test('buildIndex writes index.md preserving pending, graph.json, llms.txt', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/art.md'), page('source', 'Article', 'links [[entities/kar]]'))
  fs.writeFileSync(path.join(d, 'wiki/entities/kar.md'), page('entity', 'Karpathy'))
  fs.appendFileSync(path.join(d, 'wiki/index.md'), '- pending-concept — [[sources/art]]\n')
  const r = buildIndex(d)
  assert.equal(r.pageCount, 2)
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  assert.match(idx, /\[\[sources\/art\]\] — desc of Article/)
  assert.match(idx, /pending-concept/)
  const graph = JSON.parse(fs.readFileSync(path.join(d, 'wiki/graph.json'), 'utf8'))
  assert.equal(graph.nodes.length, 2)
  assert.ok(graph.edges.some(e => e.source === 'sources/art' && e.target === 'entities/kar' && e.type === 'wikilink'))
  assert.ok(graph.edges.some(e => e.source === 'entities/kar' && e.target === 'raw/a.md' && e.type === 'source'))
  assert.match(fs.readFileSync(path.join(d, 'llms.txt'), 'utf8'), /wiki\/sources\/art\.md/)
})

// R16 / audit LOW-1: a frontmatter description/title with newlines must not inject
// extra lines, fake headings or spoofed wikilinks into index.md / llms.txt.
test('buildIndex collapses newlines in title/description (no line injection)', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/entities/evil.md'),
    `---\ntype: entity\ntitle: "Evil\\n## Fake Heading"\ndescription: "clean\\n- [[spoof/page]]\\n## Injected"\ntags: [t]\nsources: [raw/a.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbody\n`)
  buildIndex(d)
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  const llms = fs.readFileSync(path.join(d, 'llms.txt'), 'utf8')
  assert.ok(!/^## Injected/m.test(idx), 'no injected heading in index.md')
  assert.ok(!/^- \[\[spoof\/page\]\]/m.test(idx), 'no spoofed wikilink line in index.md')
  assert.ok(!/^## Fake Heading/m.test(llms), 'no injected heading in llms.txt')
  assert.match(idx, /\[\[entities\/evil\]\] — clean - \[\[spoof\/page\]\] ## Injected/, 'newlines collapsed to spaces on one line')
})

test('buildIndex bounds the pending section and preserves user sections after it', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/art.md'), page('source', 'Article'))
  fs.appendFileSync(path.join(d, 'wiki/index.md'),
    '- pending-concept — [[sources/art]]\n\n## My reading notes\nhand-written, not yours to manage\n')
  buildIndex(d)
  buildIndex(d) // second rebuild: the greedy-match bug only compounds across rebuilds
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  assert.match(idx, /pending-concept/)
  assert.equal(idx.match(/## My reading notes/g).length, 1, 'user section survives rebuilds exactly once')
  assert.match(idx, /hand-written, not yours to manage/)
  const pendingSection = idx.match(/## Pending concepts([\s\S]*?)(?=\n## |$)/)[1]
  assert.ok(!pendingSection.includes('reading notes'), 'user section is not absorbed into pending')
})

test('buildIndex splits into topics/ files above indexSplitAt', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki.config.json'), JSON.stringify({ indexSplitAt: 2 }))
  fs.writeFileSync(path.join(d, 'wiki/sources/s1.md'), page('source', 'S1'))
  fs.writeFileSync(path.join(d, 'wiki/sources/s2.md'), page('source', 'S2'))
  fs.writeFileSync(path.join(d, 'wiki/entities/e1.md'), page('entity', 'E1'))
  const r = buildIndex(d)
  assert.equal(r.topicsSplit, true)
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  assert.match(idx, /See \[\[topics\/source\]\] \(2 pages\)/)
  assert.match(idx, /See \[\[topics\/entity\]\] \(1 pages\)/)
  assert.ok(!/\[\[sources\/s1\]\]/.test(idx), 'page lines live in topics files, not index.md')
  const topicSources = fs.readFileSync(path.join(d, 'wiki/topics/source.md'), 'utf8')
  assert.match(topicSources, /\[\[sources\/s1\]\] — desc of S1/)
  assert.match(topicSources, /\[\[sources\/s2\]\]/)
  assert.match(idx, /## Pending concepts/, 'pending section survives the split layout')
})

test('buildIndex routes unknown types to an Other section, graph keeps raw type', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/art.md'), page('source', 'Article'))
  fs.writeFileSync(path.join(d, 'wiki/entities/ds.md'), page('dataset', 'MyDataset'))
  buildIndex(d)
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  const otherSection = idx.split('## Other')[1] ?? ''
  assert.match(otherSection, /\[\[entities\/ds\]\]/)
  const sourcesSection = idx.split('## Sources')[1]?.split('##')[0] ?? ''
  assert.ok(!/entities\/ds/.test(sourcesSection), 'dataset page not bucketed under Sources')
  const graph = JSON.parse(fs.readFileSync(path.join(d, 'wiki/graph.json'), 'utf8'))
  assert.equal(graph.nodes.find(n => n.id === 'entities/ds').type, 'dataset')
})

test('buildIndex annotates invalidated pages, excludes them from llms.txt, and adds superseded_by edges', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/entities/new.md'),
    `---\ntype: entity\ntitle: New\ndescription: current\ntags: [x]\nsources: []\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody [[entities/old]]`)
  fs.writeFileSync(path.join(d, 'wiki/entities/old.md'),
    `---\ntype: entity\ntitle: Old\ndescription: obsolete\ntags: [x]\nsources: []\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: invalidated\ninvalidated: 2026-07-09\nsuperseded_by: entities/new\n---\n\nbody`)
  buildIndex(d)
  const index = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  assert.match(index, /\[\[entities\/old\]\].*invalidated, superseded by \[\[entities\/new\]\]/)
  const llms = fs.readFileSync(path.join(d, 'llms.txt'), 'utf8')
  assert.ok(llms.includes('New'))
  assert.ok(!llms.includes('obsolete'))
  const graph = JSON.parse(fs.readFileSync(path.join(d, 'wiki/graph.json'), 'utf8'))
  assert.equal(graph.nodes.find(n => n.id === 'entities/old').status, 'invalidated')
  assert.equal(graph.nodes.find(n => n.id === 'entities/new').status, undefined)
  assert.ok(graph.edges.some(e => e.source === 'entities/old' && e.target === 'entities/new' && e.type === 'superseded_by'))
})

test('buildIndex merges relations into graph.json with type/confidence and labels builtin edges', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/art.md'), page('source', 'Article', 'links [[entities/kar]]'))
  fs.writeFileSync(path.join(d, 'wiki/entities/kar.md'), page('entity', 'Karpathy', '',
    'sources: [raw/a.md]\nrelations:\n  - to: sources/art\n    type: derived_from\n  - to: sources/art.md\n    type: derived_from\n  - to: concepts/nope\n    type: uses\n  - not-a-map\n'))
  buildIndex(d)
  const graph = JSON.parse(fs.readFileSync(path.join(d, 'wiki/graph.json'), 'utf8'))
  const rel = graph.edges.filter(e => e.source === 'entities/kar' && e.type === 'derived_from')
  assert.equal(rel.length, 1, 'valid relation merged exactly once (.md-suffix duplicate deduped)')
  assert.deepEqual(rel[0], { source: 'entities/kar', target: 'sources/art', type: 'derived_from', confidence: 'inferred' })
  assert.ok(!graph.edges.some(e => e.target === 'concepts/nope'), 'relation to a missing page is dropped from the graph (lint reports it)')
  assert.equal(graph.edges.find(e => e.type === 'wikilink').confidence, 'inferred')
  assert.equal(graph.edges.find(e => e.type === 'source').confidence, 'extracted')
})

test('buildIndex keeps valid relation confidence and normalizes invalid values to inferred', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/a.md'), page('source', 'A'))
  // NOTE: the page() helper DROPS its 4th arg for type 'source' — use a concept page
  // so the relations block actually lands in the frontmatter.
  fs.writeFileSync(path.join(d, 'wiki/concepts/b.md'), page('concept', 'B', '',
    'sources: [raw/a.md]\nrelations:\n  - to: sources/a\n    type: contrasts_with\n    confidence: ambiguous\n  - to: sources/a\n    type: uses\n    confidence: banana\nsuperseded_by: sources/a\nstatus: invalidated\n'))
  buildIndex(d)
  const graph = JSON.parse(fs.readFileSync(path.join(d, 'wiki/graph.json'), 'utf8'))
  assert.equal(graph.edges.find(e => e.type === 'contrasts_with').confidence, 'ambiguous')
  assert.equal(graph.edges.find(e => e.type === 'uses').confidence, 'inferred', 'unknown confidence value falls back to inferred (lint reports it)')
  assert.equal(graph.edges.find(e => e.type === 'superseded_by').confidence, 'extracted')
})
