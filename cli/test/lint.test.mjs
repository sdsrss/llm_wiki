import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { lintKb } from '../src/lint.mjs'
import { statusKb } from '../src/status.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('lintKb finds mechanical issues and semantic candidates', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/exists.md'), 'raw')
  fs.writeFileSync(path.join(d, 'wiki/sources/a.md'),
    `---\ntype: source\ntitle: A\ndescription: d\ntags: [x]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nlink [[entities/ghost]]`)
  fs.writeFileSync(path.join(d, 'wiki/entities/e.md'),
    `---\ntype: entity\ntitle: E\ndescription: d\ntags: [x]\nsources: [raw/missing.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbody`)
  fs.writeFileSync(path.join(d, 'wiki/concepts/c.md'), 'no frontmatter at all')
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  fs.writeFileSync(path.join(d, 'wiki/index.md'), idx + '- 概念甲 — [[sources/a]], [[sources/b]]\n')
  const r = await lintKb(d, { fix: true })
  const rules = r.mechanical.map(i => i.rule)
  assert.ok(rules.includes('broken-wikilink'))
  assert.ok(rules.includes('missing-raw-source'))
  assert.ok(rules.includes('invalid-frontmatter'))
  assert.ok(rules.includes('orphan-page'))
  assert.ok(r.semantic.some(s => s.task === 'promote-concepts' && s.detail.includes('概念甲')))
  assert.ok(r.autoFixed.includes('index-rebuilt'))
  assert.ok(fs.existsSync(path.join(d, '.lint-report.json')))
})

test('statusKb reports uncompiled raw files', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/lonely.md'), 'never compiled')
  const s = await statusKb(d)
  assert.deepEqual(s.uncompiledRaw, ['raw/lonely.md'])
})
