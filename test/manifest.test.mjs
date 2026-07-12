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

test('loadManifest names the file on corrupt JSON instead of a bare SyntaxError', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, '.manifest.json'), '{ "files": { broken')
  assert.throws(() => loadManifest(d), /\.manifest\.json: invalid JSON/)
})

// R6 (audit): a valid-JSON but wrong-shape manifest (hand-edited, no `files` key)
// used to make diffManifest's Object.keys(manifest.files) throw.
test('loadManifest tolerates a manifest missing/mistyping the files key', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, '.manifest.json'), '{}')
  assert.deepEqual(loadManifest(d).files, {}, 'no files key -> empty object')
  fs.writeFileSync(path.join(d, '.manifest.json'), '{ "files": [] }')
  assert.deepEqual(loadManifest(d).files, {}, 'array files -> empty object (Object.keys-safe)')
  // and diffManifest no longer throws on the recovered shape
  assert.doesNotThrow(() => diffManifest(loadManifest(d), [{ rel: 'a.md', hash: 'h' }]))
})

test('saveManifest writes atomically and leaves no .tmp behind', (t) => {
  const d = tmp(t)
  initKb(d)
  const m = loadManifest(d)
  m.files['a.md'] = { hash: 'h1', raw: 'raw/a.md', convertedAt: '2026-07-11' }
  // Spy on fs.renameSync — writeFileAtomic's distinguishing call. The .tmp-residue
  // check below passes even for a regression to a bare fs.writeFileSync (which never
  // creates a .tmp), so observing the rename is what actually proves the atomic path.
  // The manifest is read by convert in a separate process; a torn read is mem #10097.
  const origRename = fs.renameSync
  const renamedTo = []
  fs.renameSync = (from, to) => { renamedTo.push(path.relative(d, to)); return origRename(from, to) }
  t.after(() => { fs.renameSync = origRename })
  saveManifest(d, m)
  assert.ok(fs.existsSync(path.join(d, '.manifest.json')), 'manifest present after save')
  assert.ok(!fs.existsSync(path.join(d, '.manifest.json.tmp')), 'temp sibling renamed away')
  assert.ok(renamedTo.includes('.manifest.json'), 'manifest written through writeFileAtomic (rename observed), not a direct truncating write')
  assert.deepEqual(loadManifest(d).files['a.md'].hash, 'h1', 'content readable after atomic rename')
})
