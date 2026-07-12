import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonFile, writeFileAtomic } from '../src/json.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('writeFileAtomic writes exact content and leaves no temp sibling', (t) => {
  const d = tmp(t)
  const f = path.join(d, 'store.json')
  writeFileAtomic(f, '{"a":1}\n')
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n')
  assert.ok(!fs.existsSync(`${f}.tmp`), 'the .tmp sibling is consumed by the rename, not left behind')
})

test('writeFileAtomic replaces an existing file via rename (never truncates in place)', (t) => {
  const d = tmp(t)
  const f = path.join(d, 'graph.json')
  writeFileAtomic(f, JSON.stringify({ nodes: [1, 2, 3] }))
  // A concurrent reader between truncate-and-write would see a torn file with a
  // direct writeFileSync; rename guarantees the reader sees only whole old or whole
  // new. We can at least assert the replacement is complete and parseable.
  writeFileAtomic(f, JSON.stringify({ nodes: [4, 5, 6, 7] }))
  assert.deepEqual(readJsonFile(f).nodes, [4, 5, 6, 7])
  assert.ok(!fs.existsSync(`${f}.tmp`))
})
