import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { initKb } from '../src/init.mjs'

const BIN = new URL('../bin/llm-wiki.mjs', import.meta.url).pathname

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('initKb creates full structure and is idempotent', (t) => {
  const d = tmp(t)
  const r1 = initKb(d)
  for (const f of ['AGENTS.md', 'README.md', 'wiki.config.json', '.manifest.json',
    'raw', 'wiki/index.md', 'wiki/log.md', 'wiki/sources', 'wiki/entities',
    'wiki/concepts', 'wiki/comparisons']) {
    assert.ok(fs.existsSync(path.join(d, f)), `missing ${f}`)
  }
  assert.ok(r1.created.length > 0)
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'wiki.config.json'), 'utf8'))
  for (const k of ['conceptThreshold', 'batchSize', 'indexSplitAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(cfg, k), `config missing ${k}`)
  }
  for (const k of ['rawDir', 'schemaFile', 'linkStyle']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(cfg, k), `config should omit inert key ${k}`)
  }
  const r2 = initKb(d)
  assert.equal(r2.created.length, 0)
  assert.ok(r2.skipped.length > 0)
})

test('bin: llm-wiki init <dir> works end to end', (t) => {
  const d = tmp(t)
  const out = execFileSync('node', [BIN, 'init', path.join(d, 'kb')], { encoding: 'utf8' })
  assert.match(out, /created/i)
  assert.ok(fs.existsSync(path.join(d, 'kb', 'wiki', 'index.md')))
})
