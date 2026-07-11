import test from 'node:test'
import assert from 'node:assert/strict'
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
