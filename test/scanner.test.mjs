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
