import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { loadManifest, saveManifest, diffManifest } from '../src/manifest.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('manifest load/save/diff', (t) => {
  const d = tmp(t)
  initKb(d)
  const m = loadManifest(d)
  assert.deepEqual(m.files, {})
  m.files['a.md'] = { hash: 'h1', raw: 'raw/a.md', convertedAt: '2026-07-09' }
  m.files['b.md'] = { hash: 'h2', raw: 'raw/b.md', convertedAt: '2026-07-09' }
  saveManifest(d, m)
  const diff = diffManifest(loadManifest(d), [
    { rel: 'a.md', hash: 'h1' },   // unchanged
    { rel: 'b.md', hash: 'HX' },   // changed
    { rel: 'c.md', hash: 'h3' },   // added
  ])
  assert.deepEqual(diff.added.map(e => e.rel), ['c.md'])
  assert.deepEqual(diff.changed.map(e => e.rel), ['b.md'])
  assert.deepEqual(diff.removed, [])  // nothing removed yet
  assert.deepEqual(diff.unchanged.map(e => e.rel), ['a.md'])
  const diff2 = diffManifest(loadManifest(d), [{ rel: 'a.md', hash: 'h1' }])
  assert.deepEqual(diff2.removed, ['b.md'])
})
