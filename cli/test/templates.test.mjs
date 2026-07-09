import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, agentsMdTemplate } from '../src/templates.mjs'
import { kbPaths } from '../src/paths.mjs'

test('DEFAULT_CONFIG has all spec keys with defaults', () => {
  assert.equal(DEFAULT_CONFIG.schemaFile, 'AGENTS.md')
  assert.equal(DEFAULT_CONFIG.rawDir, 'raw')
  assert.equal(DEFAULT_CONFIG.conceptThreshold, 2)
  assert.equal(DEFAULT_CONFIG.batchSize, 5)
  assert.equal(DEFAULT_CONFIG.cascadeDepth, 3)
  assert.equal(DEFAULT_CONFIG.entityCardLines, 30)
  assert.equal(DEFAULT_CONFIG.indexSplitAt, 200)
  assert.equal(DEFAULT_CONFIG.language, 'auto')
  assert.equal(DEFAULT_CONFIG.linkStyle, 'wikilink')
})

test('kbPaths derives every path from root and respects config', () => {
  const p = kbPaths('/kb')
  assert.equal(p.raw, '/kb/raw')
  assert.equal(p.indexMd, '/kb/wiki/index.md')
  assert.equal(p.graphJson, '/kb/wiki/graph.json')
  assert.equal(p.schemaFile, '/kb/AGENTS.md')
  const q = kbPaths('/kb', { rawDir: '.raw', schemaFile: 'SCHEMA.md' })
  assert.equal(q.raw, '/kb/.raw')
  assert.equal(q.schemaFile, '/kb/SCHEMA.md')
})

test('agentsMdTemplate embeds config thresholds and iron rules', () => {
  const md = agentsMdTemplate(DEFAULT_CONFIG)
  assert.match(md, /`raw\/` is immutable/i)
  assert.match(md, /O\(1\)/)
  assert.match(md, /untrusted input/i)
  assert.match(md, /2 distinct sources/) // conceptThreshold interpolated
  assert.match(md, /batch.*5/i)
})
