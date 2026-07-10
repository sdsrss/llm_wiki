import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, buildBm25Index, searchBm25 } from '../src/bm25.mjs'

test('tokenize handles mixed CJK and ascii', () => {
  const toks = tokenize('LLM Wiki 知识编译')
  assert.ok(toks.includes('llm'))
  assert.ok(toks.includes('知识'))
  assert.ok(toks.includes('编译'))
})

test('searchBm25: k truncation, zero-score filtering, empty query', () => {
  const idx = buildBm25Index([
    { id: 'a', text: 'alpha alpha alpha shared' },
    { id: 'b', text: 'alpha alpha shared' },
    { id: 'c', text: 'alpha shared' },
    { id: 'd', text: 'nothing relevant here' },
  ])
  const top2 = searchBm25(idx, 'alpha', 2)
  assert.equal(top2.length, 2, 'k truncates the result list')
  assert.deepEqual(top2.map(h => h.id), ['a', 'b'], 'sorted by score descending')
  const all = searchBm25(idx, 'alpha', 10)
  assert.ok(!all.some(h => h.id === 'd'), 'zero-score docs are filtered out')
  assert.ok(all.every(h => h.score > 0))
  assert.deepEqual(searchBm25(idx, '', 5), [], 'empty query yields no hits')
  assert.deepEqual(searchBm25(idx, '!!! ***', 5), [], 'query with no tokenizable terms yields no hits')
})

test('bm25 ranks the on-topic doc first (Chinese query)', () => {
  const idx = buildBm25Index([
    { id: 'a', text: 'Karpathy 提出三层架构：raw sources、wiki、schema。知识编译优于检索。' },
    { id: 'b', text: '数据库索引优化，B 树与查询计划，与本主题无关。' },
    { id: 'c', text: '前端组件库的样式规范与设计令牌。' },
  ])
  const hits = searchBm25(idx, '三层架构是什么', 2)
  assert.equal(hits[0].id, 'a')
  assert.ok(hits[0].score > (hits[1]?.score ?? 0))
})
