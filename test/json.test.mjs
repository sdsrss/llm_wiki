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

test('writeFileAtomic uses a distinct temp per write (concurrent writers do not collide)', (t) => {
  const d = tmp(t)
  const f = path.join(d, 'x.json')
  const temps = []
  const origWrite = fs.writeFileSync
  fs.writeFileSync = (p, data) => { temps.push(String(p)); return origWrite(p, data) }
  t.after(() => { fs.writeFileSync = origWrite })
  writeFileAtomic(f, 'a')
  writeFileAtomic(f, 'b')
  assert.equal(temps.length, 2)
  // The old fixed `${f}.tmp` made two concurrent writers share one temp: the first
  // rename consumed it, the second renamed a missing file (ENOENT). Each write must
  // get its own temp, and never the fixed name.
  assert.notEqual(temps[0], `${f}.tmp`)
  assert.notEqual(temps[0], temps[1], 'each write gets a distinct temp path')
  assert.ok(temps.every(p => p.startsWith(f) && p.endsWith('.tmp')))
  assert.equal(fs.readFileSync(f, 'utf8'), 'b', 'final content is the last complete write')
})

test('writeFileAtomic unlinks its temp when the rename fails (no stray .tmp leak)', (t) => {
  const d = tmp(t)
  const f = path.join(d, 'y.json')
  const origRename = fs.renameSync
  fs.renameSync = () => { throw new Error('boom-rename') }
  t.after(() => { fs.renameSync = origRename })
  assert.throws(() => writeFileAtomic(f, 'data'), /boom-rename/)
  // unique temps don't self-overwrite next run, so a failed write must clean up its own.
  assert.deepEqual(fs.readdirSync(d).filter(n => n.endsWith('.tmp')), [], 'temp removed after failed rename')
})
