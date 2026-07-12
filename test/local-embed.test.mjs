import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLocalModel, stripLocalPrefix, friendlyImportError, embedLocal } from '../src/local-embed.mjs'

test('isLocalModel / stripLocalPrefix recognize the local: marker', () => {
  assert.equal(isLocalModel('local:Xenova/multilingual-e5-small'), true)
  assert.equal(isLocalModel('text-embedding-3-small'), false)
  assert.equal(isLocalModel(undefined), false)
  assert.equal(stripLocalPrefix('local:Xenova/multilingual-e5-small'), 'Xenova/multilingual-e5-small')
})

test('friendlyImportError maps a missing optional dep, passes others through', () => {
  const missing = friendlyImportError(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }))
  assert.match(missing.message, /npm i @huggingface\/transformers/)
  const other = new Error('boom')
  assert.equal(friendlyImportError(other), other)
})

test('embedLocal adds e5 query/passage prefixes, non-e5 gets none, injected factory not cached', async () => {
  const seen = []
  const factory = () => async (texts) => { seen.push(texts); return texts.map(() => [1, 0]) }
  await embedLocal('Xenova/multilingual-e5-small', ['hello'], { role: 'passage', pipelineFactory: factory })
  await embedLocal('Xenova/multilingual-e5-small', ['hi there'], { role: 'query', pipelineFactory: factory })
  await embedLocal('Xenova/paraphrase-multilingual-MiniLM-L12-v2', ['plain'], { pipelineFactory: factory })
  assert.deepEqual(seen[0], ['passage: hello'], 'e5 passage prefix')
  assert.deepEqual(seen[1], ['query: hi there'], 'e5 query prefix')
  assert.deepEqual(seen[2], ['plain'], 'non-e5 model gets no prefix')
})

test('embedLocal returns the vectors the factory produced', async () => {
  const factory = () => async (texts) => texts.map((_, i) => [i, i + 1])
  const out = await embedLocal('some-model', ['a', 'b'], { pipelineFactory: factory })
  assert.deepEqual(out, [[0, 1], [1, 2]])
})
