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
    `---\ntype: source\ntitle: A\ndescription: d\ntags: [x]\nsources: [raw/exists.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nlink [[entities/ghost]]`)
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

test('lintKb flags broken raw body links but not valid ones', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/present.md'), 'raw content')
  fs.writeFileSync(path.join(d, 'wiki/sources/s.md'),
    `---\ntype: source\ntitle: S\ndescription: d\ntags: [x]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbad [[raw/missing-file.md]] good [[raw/present.md]]`)
  const r = await lintKb(d)
  const broken = r.mechanical.filter(i => i.rule === 'broken-raw-link')
  assert.equal(broken.length, 1)
  assert.match(broken[0].detail, /raw\/missing-file/)
})

test('lintKb validates invalidation fields and exempts invalidated pages from orphan rule', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/r.md'), 'raw')
  // invalidated page: bad status value on one page, dangling superseded_by on another
  fs.writeFileSync(path.join(d, 'wiki/entities/old.md'),
    `---\ntype: entity\ntitle: Old\ndescription: d\ntags: [x]\nsources: [raw/r.md]\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: invalidated\ninvalidated: 2026-07-09\nsuperseded_by: entities/ghost\n---\n\nbody`)
  fs.writeFileSync(path.join(d, 'wiki/entities/typo.md'),
    `---\ntype: entity\ntitle: Typo\ndescription: d\ntags: [x]\nsources: [raw/r.md]\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: outdated\n---\n\nbody [[entities/old]]`)
  const r = await lintKb(d)
  const rules = r.mechanical.map(i => i.rule)
  assert.ok(rules.includes('superseded-target-missing'))
  assert.ok(rules.includes('invalid-status'))
  // entities/old is invalidated AND has an incoming link; entities/typo has none.
  const orphans = r.mechanical.filter(i => i.rule === 'orphan-page').map(i => i.path)
  assert.ok(orphans.includes('entities/typo.md'))
  assert.ok(!orphans.includes('entities/old.md'))
})

test('lintKb orphan exemption covers invalidated pages with no incoming links', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/r.md'), 'raw')
  fs.writeFileSync(path.join(d, 'wiki/entities/retired.md'),
    `---\ntype: entity\ntitle: Retired\ndescription: d\ntags: [x]\nsources: [raw/r.md]\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: invalidated\ninvalidated: 2026-07-09\n---\n\nbody`)
  const r = await lintKb(d)
  assert.ok(!r.mechanical.some(i => i.rule === 'orphan-page' && i.path === 'entities/retired.md'))
})

test('statusKb reports uncompiled raw files', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/lonely.md'), 'never compiled')
  const s = await statusKb(d)
  assert.deepEqual(s.uncompiledRaw, ['raw/lonely.md'])
})

test('statusKb finds uncompiled raw files in subdirectories', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.mkdirSync(path.join(d, 'raw/sub'), { recursive: true })
  fs.writeFileSync(path.join(d, 'raw/sub/x.md'), 'nested, never compiled')
  const s = await statusKb(d)
  assert.ok(s.uncompiledRaw.includes('raw/sub/x.md'))
})

test('statusKb maps changed sources to the wiki pages citing their raw output', async (t) => {
  const d = tmp(t)
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-src-'))
  t.after(() => fs.rmSync(src, { recursive: true, force: true }))
  initKb(d)
  // manifest says doc.md was compiled to raw/doc.md with hash "stale"
  fs.writeFileSync(path.join(d, '.manifest.json'), JSON.stringify({
    files: { 'doc.md': { hash: 'stale', raw: 'raw/doc.md', convertedAt: '2026-07-01' } },
  }, null, 2))
  fs.writeFileSync(path.join(d, 'raw/doc.md'), 'compiled')
  fs.writeFileSync(path.join(d, 'wiki/sources/doc.md'),
    `---\ntype: source\ntitle: Doc\ndescription: d\ntags: [x]\nsources: [raw/doc.md]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody`)
  fs.writeFileSync(path.join(src, 'doc.md'), 'new upstream content')
  const s = await statusKb(d, src)
  const changed = s.affectedPages.find(a => a.src === 'doc.md')
  assert.equal(changed.kind, 'changed')
  assert.equal(changed.raw, 'raw/doc.md')
  assert.deepEqual(changed.pages, ['sources/doc'])
})

test('statusKb reports removed sources with their dependent pages', async (t) => {
  const d = tmp(t)
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-src-'))
  t.after(() => fs.rmSync(src, { recursive: true, force: true }))
  initKb(d)
  fs.writeFileSync(path.join(d, '.manifest.json'), JSON.stringify({
    files: { 'gone.md': { hash: 'h1', raw: 'raw/gone.md', convertedAt: '2026-07-01' } },
  }, null, 2))
  fs.writeFileSync(path.join(d, 'raw/gone.md'), 'compiled')
  fs.writeFileSync(path.join(d, 'wiki/sources/gone.md'),
    `---\ntype: source\ntitle: Gone\ndescription: d\ntags: [x]\nsources: [raw/gone.md]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody`)
  const s = await statusKb(d, src) // src dir is empty -> gone.md removed
  const removed = s.affectedPages.find(a => a.src === 'gone.md')
  assert.equal(removed.kind, 'removed')
  assert.deepEqual(removed.pages, ['sources/gone'])
})

test('statusKb affectedPages is empty without srcDir', async (t) => {
  const d = tmp(t)
  initKb(d)
  const s = await statusKb(d)
  assert.deepEqual(s.affectedPages, [])
})

test('contradiction-scan caps at small shared-tag groups', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/a.md'), 'raw')
  // two pages share tag "pair" -> group emitted; six pages share tag "mega" -> no group
  const mk = (name, tags) => fs.writeFileSync(path.join(d, `wiki/entities/${name}.md`),
    `---\ntype: entity\ntitle: ${name}\ndescription: d\ntags: [${tags}]\nsources: [raw/a.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbody [[entities/${name}]]`)
  mk('p1', 'pair, mega')
  mk('p2', 'pair, mega')
  for (const n of ['m3', 'm4', 'm5', 'm6']) mk(n, 'mega')
  const r = await lintKb(d)
  const cs = r.semantic.filter(s => s.task === 'contradiction-scan')
  assert.ok(cs.some(s => s.detail.includes('tag "pair"')), 'exactly-2-page tag still grouped')
  assert.ok(!cs.some(s => s.detail.includes('tag "mega"')), '6-page tag suppressed as navigation tag')
})

test('orphan rule exempts comparison pages but not entities', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/a.md'), 'raw')
  fs.writeFileSync(path.join(d, 'wiki/comparisons/cmp.md'),
    `---\ntype: comparison\ntitle: Cmp\ndescription: d\ntags: [t]\nsources: [raw/a.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nno incoming links`)
  fs.writeFileSync(path.join(d, 'wiki/entities/lone.md'),
    `---\ntype: entity\ntitle: Lone\ndescription: d\ntags: [t]\nsources: [raw/a.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nno incoming links`)
  const r = await lintKb(d)
  const orphans = r.mechanical.filter(i => i.rule === 'orphan-page').map(i => i.path)
  assert.ok(!orphans.some(p => p.includes('comparisons/cmp')), 'comparison not flagged as orphan')
  assert.ok(orphans.some(p => p.includes('entities/lone')), 'entity still flagged as orphan')
})

test('lintKb flags pages whose cited raw was reconverted after the page was updated', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, '.manifest.json'), JSON.stringify({
    files: { 'doc.md': { hash: 'h', raw: 'raw/doc.md', convertedAt: '2026-07-09' } },
  }, null, 2))
  fs.writeFileSync(path.join(d, 'raw/doc.md'), 'recompiled content')
  fs.writeFileSync(path.join(d, 'wiki/sources/doc.md'),
    `---\ntype: source\ntitle: Doc\ndescription: d\ntags: [x]\nsources: [raw/doc.md]\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n\nbody`)
  // fresh page citing the same raw: no flag
  fs.writeFileSync(path.join(d, 'wiki/entities/fresh.md'),
    `---\ntype: entity\ntitle: Fresh\ndescription: d\ntags: [x]\nsources: [raw/doc.md]\ncreated: 2026-07-10\nupdated: 2026-07-10\n---\n\nbody [[sources/doc]]`)
  const r = await lintKb(d)
  const stale = r.semantic.filter(s => s.task === 'stale-scan')
  assert.equal(stale.length, 1)
  assert.match(stale[0].detail, /sources\/doc\.md/)
  assert.match(stale[0].detail, /raw\/doc\.md/)
})

test('lintKb stale-scan skips invalidated pages', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, '.manifest.json'), JSON.stringify({
    files: { 'doc.md': { hash: 'h', raw: 'raw/doc.md', convertedAt: '2026-07-09' } },
  }, null, 2))
  fs.writeFileSync(path.join(d, 'raw/doc.md'), 'recompiled')
  fs.writeFileSync(path.join(d, 'wiki/sources/doc.md'),
    `---\ntype: source\ntitle: Doc\ndescription: d\ntags: [x]\nsources: [raw/doc.md]\ncreated: 2026-06-01\nupdated: 2026-06-01\nstatus: invalidated\ninvalidated: 2026-07-01\n---\n\nbody`)
  const r = await lintKb(d)
  assert.equal(r.semantic.filter(s => s.task === 'stale-scan').length, 0)
})
