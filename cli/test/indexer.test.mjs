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
