import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { scanSource, estimateTokens } from '../src/scanner.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('estimateTokens: CJK counted ~1.6 chars/token, ascii ~4', () => {
  assert.ok(Math.abs(estimateTokens('测试中文内容啊'.repeat(10)) - 70 / 1.6) < 5)
  assert.ok(Math.abs(estimateTokens('a'.repeat(400)) - 100) < 5)
})

test('scanSource: dedup, batching, plan file', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  // NOTE: body must be non-periodic — a repeated phrase yields ~16 distinct 5-char shingles,
  // where 32-perm minhash underestimates a true jaccard of 0.889 as 0.75 (< 0.85 threshold).
  const body = Array.from({ length: 50 }, (_, i) => `知识编译方法论正文内容第${i}节。`).join('')
  fs.writeFileSync(path.join(src, 'a.md'), '# A\n' + body)
  fs.writeFileSync(path.join(src, 'a-copy.md'), '# A\n' + body)          // exact dup
  fs.writeFileSync(path.join(src, 'a-near.md'), '# A\n' + body + '尾巴') // near dup
  fs.mkdirSync(path.join(src, 'sub'))
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(src, 'sub', `f${i}.md`), `# F${i}\n${'unique english content '.repeat(30)}${i}`)
  fs.writeFileSync(path.join(src, 'skip.bin'), 'binary')
  const r = await scanSource(src, kb, {})
  assert.equal(r.duplicates.exact.length, 1)
  assert.ok(r.duplicates.near.some(([a, b]) => [a, b].includes('a-near.md')))
  assert.ok(r.skipped.some(s => s.rel === 'skip.bin'))
  // unique compile set = a.md + a-near.md + 6 sub files = 8 -> 2 batches of 5
  const planned = r.batches.flat()
  assert.equal(planned.length, 8)
  assert.equal(r.batches.length, 2)
  assert.ok(r.estimate.inputTokens > r.estimate.contentTokens)
  assert.ok(fs.existsSync(path.join(kb, '.scan-plan.json')))
})

test('scanSource: symlinked dirs are reported as skipped, symlinked files still scanned', async (t) => {
  const src = tmp(t), kb = tmp(t), outside = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(outside, 'in-linked-dir.md'), '# Hidden\nbody')
  fs.writeFileSync(path.join(outside, 'linked-file.md'), '# Linked\nbody')
  fs.writeFileSync(path.join(src, 'plain.md'), '# Plain\nbody')
  fs.symlinkSync(outside, path.join(src, 'linked-dir'))
  fs.symlinkSync(path.join(outside, 'linked-file.md'), path.join(src, 'linked-file.md'))
  fs.symlinkSync(path.join(src, 'nowhere.md'), path.join(src, 'dangling.md'))
  const r = await scanSource(src, kb, {})
  assert.ok(r.skipped.some(s => s.rel === 'linked-dir' && s.reason.includes('symlinked directory')), 'dir symlink surfaces in skipped instead of vanishing')
  assert.ok(r.skipped.some(s => s.rel === 'dangling.md' && s.reason === 'broken symlink'))
  assert.ok(r.files.some(f => f.rel === 'linked-file.md'), 'file symlink is followed as before')
  assert.ok(!r.files.some(f => f.rel.includes('in-linked-dir')), 'linked dir contents not walked')
})

test('scanSource --exclude skips matching paths with reason "excluded"', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, 'keep.md'), '# Keep\nbody')
  fs.mkdirSync(path.join(src, 'drafts'))
  fs.writeFileSync(path.join(src, 'drafts/wip.md'), '# WIP\nbody')
  fs.writeFileSync(path.join(src, 'notes-draft.md'), '# Draft\nbody')
  const r = await scanSource(src, kb, { exclude: ['draft'] })
  assert.deepEqual(r.files.map(f => f.rel), ['keep.md'])
  const excluded = r.skipped.filter(s => s.reason === 'excluded').map(s => s.rel).sort()
  assert.deepEqual(excluded, ['drafts/wip.md', 'notes-draft.md'], 'substring match applies to the full relative path')
})

test('scanSource: empty file gets lang en and zero tokens (no NaN path)', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, 'empty.md'), '')
  const r = await scanSource(src, kb, {})
  const e = r.files.find(f => f.rel === 'empty.md')
  assert.equal(e.lang, 'en')
  assert.equal(e.tokens, 0)
})

test('scanSource persist:false computes the report without writing the plan file', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, 'a.md'), '# A\nbody')
  const r = await scanSource(src, kb, { persist: false })
  assert.equal(r.files.length, 1)
  assert.ok(!fs.existsSync(path.join(kb, '.scan-plan.json')))
})
