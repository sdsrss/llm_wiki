import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFrontmatter, serializeFrontmatter } from '../src/frontmatter.mjs'
import { listWikiPages, validatePage } from '../src/pages.mjs'
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
created: 2026-07-09
updated: 2026-07-09
---

Body with a [[entities/karpathy]] link.
`

test('parseFrontmatter round-trips through serializeFrontmatter', () => {
  const fm = parseFrontmatter(GOOD)
  assert.equal(fm.data.type, 'source')
  assert.match(fm.body, /Body with/)
  const again = parseFrontmatter(serializeFrontmatter(fm.data, fm.body))
  assert.deepEqual(again.data, fm.data)
})

test('parseFrontmatter flags bad yaml and missing frontmatter', () => {
  assert.equal(parseFrontmatter('no frontmatter'), null)
  assert.equal(parseFrontmatter('---\n: [\n---\nx').error, 'invalid-yaml')
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
