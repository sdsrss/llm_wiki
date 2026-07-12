import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalize, pageEmbedText, vectorStorePath, loadVectorStore, saveVectorStore, cosineTopK } from '../src/vector.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-vec-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  fs.mkdirSync(path.join(d, 'wiki'), { recursive: true })
  return d
}

test('normalize returns a unit vector and null for zero/empty input', () => {
  const n = normalize([3, 4])
  assert.ok(Math.abs(n[0] - 0.6) < 1e-9 && Math.abs(n[1] - 0.8) < 1e-9)
  assert.equal(normalize([0, 0]), null)
  assert.equal(normalize([]), null)
})

test('pageEmbedText joins the same fields BM25 indexes', () => {
  const pg = { data: { title: 'T', description: 'D', tags: ['a', 'b'] }, body: 'BODY' }
  assert.equal(pageEmbedText(pg), 'T\nD\na b\nBODY')
  assert.equal(pageEmbedText({ data: { title: 'T' }, body: 'B' }), 'T\n\n\nB')
})

test('vector store roundtrip: save rounds to 5 decimals, load returns shape', (t) => {
  const d = tmp(t)
  saveVectorStore(d, { model: 'm', dim: 2, pages: { 'sources/a.md': { hash: 'h', vec: [0.123456789, 1] } } })
  const s = loadVectorStore(d)
  assert.equal(s.model, 'm')
  assert.deepEqual(s.pages['sources/a.md'].vec, [0.12346, 1])
  assert.equal(vectorStorePath(d), path.join(d, 'wiki', '.vectors.json'))
})

test('saveVectorStore writes atomically (rename observed, no .tmp residue)', (t) => {
  const d = tmp(t)
  // The sidecar is JSON.parse'd by loadVectorStore at query time in a separate process;
  // a bare fs.writeFileSync truncates it first, so a concurrent read sees a torn file.
  // The .tmp-residue check alone passes even for a direct write (no .tmp ever created) —
  // spying on fs.renameSync (writeFileAtomic's distinguishing call) is what proves the
  // atomic path and would redden a regression to a truncating write. Guards mem #10097.
  const origRename = fs.renameSync
  const renamedTo = []
  fs.renameSync = (from, to) => { renamedTo.push(path.relative(d, to)); return origRename(from, to) }
  t.after(() => { fs.renameSync = origRename })
  saveVectorStore(d, { model: 'm', dim: 2, pages: { 'sources/a.md': { hash: 'h', vec: [1, 0] } } })
  assert.ok(!fs.existsSync(path.join(d, 'wiki', '.vectors.json.tmp')), 'temp sibling renamed away')
  assert.ok(renamedTo.includes(path.join('wiki', '.vectors.json')), 'store written through writeFileAtomic (rename observed), not a direct truncating write')
  assert.equal(loadVectorStore(d).model, 'm', 'content readable after atomic rename')
})

test('loadVectorStore returns null when the sidecar is missing', (t) => {
  const d = tmp(t)
  assert.equal(loadVectorStore(d), null)
})

test('loadVectorStore fails open (null) on corrupt JSON instead of throwing', (t) => {
  const d = tmp(t)
  fs.writeFileSync(vectorStorePath(d), '{ corrupt not json')
  assert.equal(loadVectorStore(d), null)
})

test('cosineTopK ranks by dot product, filters non-positive, slices k, skips dim mismatch', () => {
  const store = { model: 'm', dim: 2, pages: {
    'a.md': { hash: 'h', vec: [1, 0] },
    'b.md': { hash: 'h', vec: [0.6, 0.8] },
    'c.md': { hash: 'h', vec: [-1, 0] },
    'd.md': { hash: 'h', vec: [1, 0, 0] },
  } }
  const hits = cosineTopK([1, 0], store, 2)
  assert.deepEqual(hits.map(h => h.id), ['a.md', 'b.md'])
  assert.ok(hits[0].score > hits[1].score)
  assert.equal(cosineTopK([1, 0], store, 10).length, 2) // c negative, d dim-mismatch
})
