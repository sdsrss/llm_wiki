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
