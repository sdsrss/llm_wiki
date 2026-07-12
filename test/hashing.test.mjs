import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256Text, minhashSignature, jaccardEstimate, MINHASH_MAX_SHINGLE_CHARS } from '../src/hashing.mjs'

test('sha256Text is stable', () => {
  assert.equal(sha256Text('abc'), sha256Text('abc'))
  assert.notEqual(sha256Text('abc'), sha256Text('abd'))
})

test('minhash: near-duplicates score high, unrelated score low', () => {
  // NOTE: base must be a long document with a large distinct-shingle universe.
  // The original brief used `'…。'.repeat(30)`, which collapses to ~15 distinct
  // 5-gram shingles, capping the true Jaccard vs `near` at ~0.55 — below 0.8 for
  // any correct minhash. Use unique numbered sentences so near-duplicates share
  // >80% of shingles.
  const baseParts = []
  for (let i = 0; i < 40; i++) baseParts.push('第' + i + '章：大语言模型知识库的编译方法论，讨论主题' + i + '的采集清洗与结构化。')
  const base = baseParts.join('')
  const near = base + '另外补充一句与整体无关紧要的结尾说明。'
  const otherParts = []
  for (let i = 0; i < 40; i++) otherParts.push('条目' + i + '：数据库索引优化与查询计划分析，涵盖第' + i + '类扫描代价评估。')
  const other = otherParts.join('')
  const s1 = minhashSignature(base)
  assert.equal(s1.length, 128)
  assert.ok(jaccardEstimate(s1, minhashSignature(near)) > 0.8)
  assert.ok(jaccardEstimate(s1, minhashSignature(other)) < 0.3)
})

test('minhash: a true-~0.90 near-duplicate clears the 0.85 threshold at the default perm count (QA73-002)', () => {
  // Regression for QA73-002: this pair's true Jaccard is 0.898, but at 32 perms the
  // estimate was 0.844 (< NEAR_DUP_THRESHOLD 0.85) and the near-dup was silently missed.
  // The default perm count must stay high enough that a genuine near-duplicate is detected.
  const lines = []
  for (let i = 0; i < 60; i++) lines.push('sentence number ' + i + ' about distributed systems and consensus protocols')
  const a = '# Doc\n' + lines.join('\n') + '\n'
  const b = a + 'EXTRA trailing line added here only\n'
  assert.ok(jaccardEstimate(minhashSignature(a), minhashSignature(b)) >= 0.85,
    'default-perm minhash must estimate a true-0.90 pair at or above the 0.85 threshold')
})

test('minhash: shingling is capped to a prefix so cost stays bounded on huge inputs (R3)', () => {
  // minhashSignature is O(len x perms); the scanner's 50MB file cap does not bound it,
  // so a large legit text file would hang `scan`. The scan is capped to the first
  // MINHASH_MAX_SHINGLE_CHARS of normalized text. Two inputs sharing that whole prefix
  // but diverging only afterwards must produce IDENTICAL signatures — proof that bytes
  // past the cap are never shingled (the deterministic stand-in for the perf bound).
  const prefix = 'x'.repeat(MINHASH_MAX_SHINGLE_CHARS + 100)
  const a = prefix + 'AAAAAAAAAA totally different tail A'
  const b = prefix + 'BBBBBBBBBB totally different tail B'
  assert.deepEqual(minhashSignature(a), minhashSignature(b),
    'content beyond MINHASH_MAX_SHINGLE_CHARS must not affect the signature')
  // And the cap does not perturb small inputs (the common case): a sub-cap document
  // still signs its full content, so near-dup detection below the cap is unchanged.
  const small = 'the quick brown fox jumps over the lazy dog, repeatedly and distinctly '.repeat(20)
  assert.equal(minhashSignature(small).length, 128)
})
