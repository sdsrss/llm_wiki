import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { pickFiles, wrapPage } from '../scripts/eval/make-corpus.mjs'

test('pickFiles stride-samples deterministically and errors when short', () => {
  const paths = Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, '0')}.md`)
  const picked = pickFiles(paths, 5)
  assert.equal(picked.length, 5)
  assert.deepEqual(picked, pickFiles(paths, 5)) // deterministic
  assert.deepEqual(picked, ['p00.md', 'p02.md', 'p04.md', 'p06.md', 'p08.md'])
  assert.throws(() => pickFiles(paths.slice(0, 3), 5), /only 3 candidate files/)
})

test('wrapPage derives slug, title, description and keeps the full body', () => {
  const md = '# My Package\n\nDoes useful things, quickly.\n\n## Install\n\nnpm i my-package\n'
  const pg = wrapPage('node_modules/my-package/README.md', md)
  assert.equal(pg.slug, 'my-package-readme')
  assert.match(pg.text, /^---\ntitle: "My Package"\n/)
  assert.match(pg.text, /description: "Does useful things, quickly\."/)
  assert.match(pg.text, /## Install/) // full original body present
})

test('wrapPage falls back to the filename when there is no heading', () => {
  const pg = wrapPage('node_modules/x/docs/api.md', 'plain text only\n\nmore.\n')
  assert.equal(pg.slug, 'x-docs-api')
  assert.match(pg.text, /title: "api"/)
})

test('eval.mjs rejects a probe whose expect id is an invalidated page', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-evalval-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/concepts/dead.md'),
    `---\ntype: concept\ntitle: Dead\ndescription: retired\nstatus: invalidated\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n\nretired.`)
  buildIndex(d)
  const probes = path.join(d, 'probes.jsonl')
  fs.writeFileSync(probes, JSON.stringify({ q: 'dead?', expect: ['concepts/dead'], lang: 'en', type: 'fact' }) + '\n')
  const r = spawnSync(process.execPath, ['scripts/eval/eval.mjs', '--kb', d, '--probes', probes, '--arms', 'bm25'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown page id/, 'invalidated expect id is rejected like a missing one')
})
