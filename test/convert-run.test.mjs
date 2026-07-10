import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { scanSource } from '../src/scanner.mjs'
import { runConvertPlan } from '../src/convert-run.mjs'
import { loadManifest } from '../src/manifest.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('runConvertPlan writes raw files and manifest; second scan shows unchanged', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, '文章 一.md'), '# 文章一\n正文' + 'x'.repeat(100))
  fs.writeFileSync(path.join(src, 'b.txt'), 'plain text body '.repeat(20))
  await scanSource(src, kb, {})
  const r = await runConvertPlan(kb)
  assert.equal(r.converted.length, 2)
  assert.equal(r.failed.length, 0)
  const rawFiles = fs.readdirSync(path.join(kb, 'raw')).filter(f => f.endsWith('.md'))
  assert.equal(rawFiles.length, 2)
  const m = loadManifest(kb)
  assert.equal(Object.keys(m.files).length, 2)
  const r2 = await scanSource(src, kb, {})
  assert.equal(r2.incremental.unchanged, 2)
  assert.equal(r2.batches.length, 0)
})

test('same-basename originals from different dirs get collision suffixes and re-converts reuse them', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.mkdirSync(path.join(src, 'a'))
  fs.mkdirSync(path.join(src, 'b'))
  fs.writeFileSync(path.join(src, 'a/doc.txt'), 'content from dir a '.repeat(10))
  fs.writeFileSync(path.join(src, 'b/doc.txt'), 'content from dir b '.repeat(10))
  await scanSource(src, kb, {})
  await runConvertPlan(kb)
  const origs = fs.readdirSync(path.join(kb, 'raw/_originals')).sort()
  assert.deepEqual(origs, ['doc-2.txt', 'doc.txt'], 'second same-basename original gets a suffix, not an overwrite')
  const m = loadManifest(kb)
  const contents = [m.files['a/doc.txt'], m.files['b/doc.txt']]
    .map(e => fs.readFileSync(path.join(kb, e.original), 'utf8'))
  assert.ok(contents.some(c => c.includes('dir a')) && contents.some(c => c.includes('dir b')),
    'both originals preserved with distinct content')
  // re-convert a changed source: reuses its recorded original path, no third file
  fs.writeFileSync(path.join(src, 'a/doc.txt'), 'revised content from dir a '.repeat(10))
  await scanSource(src, kb, {})
  await runConvertPlan(kb)
  const m2 = loadManifest(kb)
  assert.equal(m2.files['a/doc.txt'].original, m.files['a/doc.txt'].original, 'original path stable across re-converts')
  assert.equal(fs.readdirSync(path.join(kb, 'raw/_originals')).length, 2, 'no doc-3.txt created')
  assert.match(fs.readFileSync(path.join(kb, m2.files['a/doc.txt'].original), 'utf8'), /revised content/)
})

test('re-converting a changed source overwrites its raw file in place (no orphans)', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, 'doc.md'), '# Doc\noriginal body ' + 'x'.repeat(100))
  await scanSource(src, kb, {})
  await runConvertPlan(kb)
  const rawBefore = loadManifest(kb).files['doc.md'].raw
  fs.writeFileSync(path.join(src, 'doc.md'), '# Doc\nrevised body ' + 'y'.repeat(100))
  await scanSource(src, kb, {})
  const r = await runConvertPlan(kb)
  assert.equal(r.converted.length, 1)
  const m = loadManifest(kb)
  assert.equal(m.files['doc.md'].raw, rawBefore, 'manifest keeps pointing at the same raw path')
  const rawFiles = fs.readdirSync(path.join(kb, 'raw')).filter(f => f.endsWith('.md'))
  assert.equal(rawFiles.length, 1, 'no orphan doc-2.md left behind')
  assert.match(fs.readFileSync(path.join(kb, rawBefore), 'utf8'), /revised body/)
})
