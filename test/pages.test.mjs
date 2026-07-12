import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFrontmatter } from '../src/frontmatter.mjs'
import { listWikiPages, validatePage, isInvalidated, asList } from '../src/pages.mjs'
import { initKb } from '../src/init.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

const GOOD = `---
type: source
title: Test article
description: One line
tags: [ai]
sources: [raw/a.md]
created: 2026-07-09
updated: 2026-07-09
---

Body with a [[entities/karpathy]] link.
`

test('parseFrontmatter extracts data and body', () => {
  const fm = parseFrontmatter(GOOD)
  assert.equal(fm.data.type, 'source')
  assert.match(fm.body, /Body with/)
})

test('parseFrontmatter flags bad yaml and missing frontmatter', () => {
  assert.equal(parseFrontmatter('no frontmatter'), null)
  assert.equal(parseFrontmatter('---\n: [\n---\nx').error, 'invalid-yaml')
  // Opens with `---` but never closes it: distinct from truly-absent frontmatter so
  // the author knows to close the delimiter, not add one.
  assert.equal(parseFrontmatter('---\ntype: concept\ntitle: X\n\n# body, no closing ---').error, 'unterminated-frontmatter')
  assert.equal(parseFrontmatter('# just a heading\n\nbody'), null, 'no leading --- stays truly-missing')
})

test('listWikiPages + validatePage', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/good.md'), GOOD)
  fs.writeFileSync(path.join(d, 'wiki/entities/bad.md'), '---\ntype: entity\n---\nno required fields')
  const pages = listWikiPages(d)
  assert.equal(pages.length, 2)
  const good = pages.find(p => p.relPath === 'sources/good.md')
  assert.equal(validatePage(good).length, 0)
  const bad = pages.find(p => p.relPath === 'entities/bad.md')
  const issues = validatePage(bad)
  assert.ok(issues.some(i => i.includes('title')))
  assert.ok(issues.some(i => i.includes('sources')), 'entity requires sources field')
})

test('asList coerces non-array frontmatter fields to [] so consumers never crash', () => {
  // a bare scalar `tags: cache` parses as a string — must not reach .join()/for-of as-is
  assert.deepEqual(asList(['a', 'b']), ['a', 'b'])
  assert.deepEqual(asList('cache'), [])
  assert.deepEqual(asList(undefined), [])
  assert.deepEqual(asList(null), [])
  assert.deepEqual(asList(42), [])
})

test('validatePage flags tags authored as a bare scalar instead of a YAML list', (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/entities/scalar.md'),
    '---\ntype: entity\ntitle: T\ndescription: d\ntags: cache\nsources: raw/a.md\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbody')
  const pg = listWikiPages(d).find(p => p.relPath === 'entities/scalar.md')
  const issues = validatePage(pg)
  assert.ok(issues.some(i => i.includes('tags must be a YAML list')), 'string tags flagged')
  assert.ok(issues.some(i => i.includes('sources')), 'string sources flagged')
})

test('isInvalidated reads the optional status field', () => {
  assert.equal(isInvalidated({ data: { status: 'invalidated' } }), true)
  assert.equal(isInvalidated({ data: { status: 'active' } }), false)
  assert.equal(isInvalidated({ data: {} }), false)
})
