import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallAtK, mrr, summarize } from '../scripts/eval/lib.mjs'

test('recallAtK: fraction of expected ids found in top-k', () => {
  assert.equal(recallAtK(['a', 'b'], ['a', 'x', 'b', 'y'], 2), 0.5)
  assert.equal(recallAtK(['a', 'b'], ['a', 'x', 'b', 'y'], 3), 1)
  assert.equal(recallAtK(['a'], ['x', 'y'], 5), 0)
  assert.equal(recallAtK([], ['x'], 5), 0)
})

test('mrr: reciprocal rank of first expected hit, 0 when absent', () => {
  assert.equal(mrr(['b'], ['a', 'b', 'c']), 0.5)
  assert.equal(mrr(['a', 'c'], ['c', 'a']), 1)
  assert.equal(mrr(['z'], ['a', 'b']), 0)
})

test('summarize: per-arm means', () => {
  const s = summarize([
    { arm: 'bm25', recall: 1, mrr: 1, ms: 10 },
    { arm: 'bm25', recall: 0, mrr: 0, ms: 30 },
    { arm: 'hybrid', recall: 1, mrr: 0.5, ms: 100 },
  ])
  assert.deepEqual(s.bm25, { n: 2, recall: 0.5, mrr: 0.5, avgMs: 20, byType: { fact: { n: 2, recall: 0.5, mrr: 0.5, avgMs: 20 } } })
  assert.deepEqual(s.hybrid, { n: 1, recall: 1, mrr: 0.5, avgMs: 100, byType: { fact: { n: 1, recall: 1, mrr: 0.5, avgMs: 100 } } })
})

test('summarize groups metrics by probe type per arm', () => {
  const rows = [
    { arm: 'bm25', type: 'fact', recall: 1, mrr: 1, ms: 10 },
    { arm: 'bm25', type: 'fact', recall: 0, mrr: 0, ms: 10 },
    { arm: 'bm25', type: 'xlang', recall: 1, mrr: 0.5, ms: 20 },
  ]
  const s = summarize(rows)
  assert.equal(s.bm25.n, 3)
  assert.equal(s.bm25.byType.fact.n, 2)
  assert.equal(s.bm25.byType.fact.recall, 0.5)
  assert.equal(s.bm25.byType.xlang.mrr, 0.5)
})

test('summarize buckets rows without a type under "fact"', () => {
  const s = summarize([{ arm: 'a', recall: 1, mrr: 1, ms: 1 }])
  assert.equal(s.a.byType.fact.n, 1)
})

test('summarize keeps the existing top-level shape', () => {
  const s = summarize([{ arm: 'a', type: 'fact', recall: 1, mrr: 0.5, ms: 4 }])
  assert.deepEqual(Object.keys(s.a).sort(), ['avgMs', 'byType', 'mrr', 'n', 'recall'])
})
