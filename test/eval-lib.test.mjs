import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallAtK, mrr, summarize, extractCitations, deswap, headToHead, abstentionSummary, degreeRank } from '../scripts/eval/lib.mjs'

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

test('extractCitations pulls unique [[ids]] ignoring anchors and aliases', () => {
  const t = 'See [[concepts/rag]] and [[concepts/rag#缺陷|the flaws]]; also [[entities/karpathy]]. Not a link: [single].'
  assert.deepEqual(extractCitations(t), ['concepts/rag', 'entities/karpathy'])
})

test('deswap keeps agreeing verdicts and ties disagreements', () => {
  // second judging ran with A/B swapped, so "B" there means "A" here
  const v1 = { correctness: 'A', citations: 'tie', completeness: 'A' }
  const v2swapped = { correctness: 'B', citations: 'tie', completeness: 'A' }
  assert.deepEqual(deswap(v1, v2swapped), { correctness: 'A', citations: 'tie', completeness: 'tie' })
})

test('headToHead counts wins per dimension', () => {
  const pairs = [
    { correctness: 'A', citations: 'B', completeness: 'tie' },
    { correctness: 'A', citations: 'tie', completeness: 'tie' },
  ]
  const h = headToHead(pairs)
  assert.deepEqual(h.correctness, { A: 2, B: 0, tie: 0, n: 2 })
  assert.deepEqual(h.citations, { A: 0, B: 1, tie: 1, n: 2 })
})

test('abstentionSummary splits rates by probe type', () => {
  const rows = [
    { arm: 'bm25', type: 'none', abstained: true },
    { arm: 'bm25', type: 'none', abstained: false },
    { arm: 'bm25', type: 'fact', abstained: false },
    { arm: 'bm25', type: 'fact', abstained: true },
  ]
  const s = abstentionSummary(rows)
  assert.equal(s.bm25.abstentionRate, 0.5)   // on "none" probes — higher is better
  assert.equal(s.bm25.falseAbstentionRate, 0.5) // on answerable probes — lower is better
  assert.equal(s.bm25.nNone, 2)
  assert.equal(s.bm25.nAnswerable, 2)
})

test('degreeRank orders ids by wiki in-degree, ignoring raw/ targets, stable on ties', () => {
  const graph = { nodes: [], edges: [
    { source: 'a', target: 'b', type: 'wikilink' },
    { source: 'c', target: 'b', type: 'uses' },
    { source: 'a', target: 'c', type: 'wikilink' },
    { source: 'a', target: 'raw/x.md', type: 'source' },
  ] }
  assert.deepEqual(degreeRank(graph, ['a', 'c', 'b']), ['b', 'c', 'a'])
  // tie between a (0) and d (0): input order preserved
  assert.deepEqual(degreeRank(graph, ['d', 'a']), ['d', 'a'])
})
