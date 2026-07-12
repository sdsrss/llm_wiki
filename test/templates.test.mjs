import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, agentsMdTemplate, readmeTemplate, loadKbConfig } from '../src/templates.mjs'
import { kbPaths } from '../src/paths.mjs'

test('DEFAULT_CONFIG has all spec keys with defaults', () => {
  assert.equal(DEFAULT_CONFIG.conceptThreshold, 2)
  assert.equal(DEFAULT_CONFIG.batchSize, 5)
  assert.equal(DEFAULT_CONFIG.cascadeDepth, 3)
  assert.equal(DEFAULT_CONFIG.entityCardLines, 30)
  assert.equal(DEFAULT_CONFIG.indexSplitAt, 200)
  assert.equal(DEFAULT_CONFIG.language, 'auto')
  assert.equal(DEFAULT_CONFIG.linkStyle, 'wikilink')
  assert.equal(DEFAULT_CONFIG.maxFileBytes, 52428800)
  assert.equal(DEFAULT_CONFIG.bm25TitleWeight, 3)
  assert.ok(!('rawDir' in DEFAULT_CONFIG) && !('schemaFile' in DEFAULT_CONFIG),
    'unwired pseudo-config keys removed — raw/ and AGENTS.md are fixed layout')
})

// R9 (audit): the generated per-KB README must pin @0 like every other doc path,
// so a future 1.x can't silently change the installed behavior users npx into.
test('readmeTemplate pins the npx command to @0', () => {
  const readme = readmeTemplate('my-kb')
  assert.match(readme, /npx @sdsrs\/llm-wiki@0 ask/, 'ask command carries the @0 pin')
  assert.ok(!/npx @sdsrs\/llm-wiki ask/.test(readme), 'no unpinned npx command')
})

// R11 (audit): hot.md is scaffolded and read by wiki-query, so the AGENTS.md contract
// must tell a contract-only agent to maintain it during ingest.
test('agentsMdTemplate documents hot.md in the ingest contract', () => {
  assert.match(agentsMdTemplate(DEFAULT_CONFIG), /hot\.md/, 'contract names hot.md maintenance')
})

test('loadKbConfig merges defaults and names the file on corrupt JSON', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  assert.deepEqual(loadKbConfig(d), DEFAULT_CONFIG, 'no config file -> defaults')
  fs.writeFileSync(path.join(d, 'wiki.config.json'), '{"batchSize": 9}')
  const cfg = loadKbConfig(d)
  assert.equal(cfg.batchSize, 9)
  assert.equal(cfg.conceptThreshold, DEFAULT_CONFIG.conceptThreshold, 'unset keys keep defaults')
  fs.writeFileSync(path.join(d, 'wiki.config.json'), '{"batchSize": ')
  assert.throws(() => loadKbConfig(d), /wiki\.config\.json: invalid JSON/)
})

test('kbPaths derives every path from a fixed layout', () => {
  const p = kbPaths('/kb')
  assert.equal(p.raw, '/kb/raw')
  assert.equal(p.indexMd, '/kb/wiki/index.md')
  assert.equal(p.graphJson, '/kb/wiki/graph.json')
  assert.equal(p.schemaFile, '/kb/AGENTS.md')
})

test('agentsMdTemplate embeds config thresholds and iron rules', () => {
  const md = agentsMdTemplate(DEFAULT_CONFIG)
  assert.match(md, /`raw\/` is immutable/i)
  assert.match(md, /O\(1\)/)
  assert.match(md, /untrusted input/i)
  assert.match(md, /2 distinct sources/) // conceptThreshold interpolated
  assert.match(md, /batch.*5/i)
})

test('agentsMdTemplate documents the invalidation discipline', () => {
  const md = agentsMdTemplate(DEFAULT_CONFIG)
  assert.ok(md.includes('status: invalidated'))
  assert.ok(md.includes('superseded_by'))
  assert.ok(md.includes('Never delete'))
})

test('agentsMdTemplate documents typed relations with the configured vocabulary', () => {
  const md = agentsMdTemplate(DEFAULT_CONFIG)
  assert.match(md, /## Typed relations/)
  assert.match(md, /relations:/)
  assert.match(md, /implements, uses, depends_on/)
  assert.match(md, /extracted \| inferred \| ambiguous/)
})

test('agentsMdTemplate wiki-layer line harmonizes review with the hand-edit exception', () => {
  const md = agentsMdTemplate(DEFAULT_CONFIG)
  assert.match(md, /Humans review — and may occasionally hand-edit/)
  assert.doesNotMatch(md, /Humans only review/)
})

test('agentsMdTemplate documents aliases and the Obsidian browse-and-annotate convention', () => {
  const md = agentsMdTemplate(DEFAULT_CONFIG)
  assert.match(md, /Optional frontmatter: aliases/)
  assert.match(md, /## Obsidian \(browse & annotate\)/)
  assert.match(md, /run `llm-wiki index` afterwards/)
  assert.match(md, /Do not create or edit \.obsidian\//)
})
