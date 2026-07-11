import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, agentsMdTemplate, loadKbConfig } from '../src/templates.mjs'
import { kbPaths } from '../src/paths.mjs'

test('DEFAULT_CONFIG has all spec keys with defaults', () => {
  assert.equal(DEFAULT_CONFIG.conceptThreshold, 2)
  assert.equal(DEFAULT_CONFIG.batchSize, 5)
  assert.equal(DEFAULT_CONFIG.cascadeDepth, 3)
  assert.equal(DEFAULT_CONFIG.entityCardLines, 30)
  assert.equal(DEFAULT_CONFIG.indexSplitAt, 200)
  assert.equal(DEFAULT_CONFIG.language, 'auto')
  assert.equal(DEFAULT_CONFIG.linkStyle, 'wikilink')
  assert.ok(!('rawDir' in DEFAULT_CONFIG) && !('schemaFile' in DEFAULT_CONFIG),
    'unwired pseudo-config keys removed — raw/ and AGENTS.md are fixed layout')
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
