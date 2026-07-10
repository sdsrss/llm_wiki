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
