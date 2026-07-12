import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { lintKb } from '../src/lint.mjs'
import { statusKb } from '../src/status.mjs'
import { scanSource } from '../src/scanner.mjs'
import { runConvertPlan } from '../src/convert-run.mjs'
import { loadManifest } from '../src/manifest.mjs'

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

test('lintKb missing-field rule fires per absent required field', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/r.md'), 'raw')
  // valid yaml frontmatter, but description/tags/sources are absent
  fs.writeFileSync(path.join(d, 'wiki/entities/sparse.md'),
    `---\ntype: entity\ntitle: Sparse\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbody [[entities/sparse]]`)
  const r = await lintKb(d)
  const missing = r.mechanical.filter(i => i.rule === 'missing-field' && i.path === 'entities/sparse.md')
  const details = missing.map(i => i.detail)
  assert.ok(details.some(x => x.includes('description')))
  assert.ok(details.some(x => x.includes('tags')))
  assert.ok(details.some(x => x.includes('sources')), 'sources evidence chain required')
  assert.ok(!details.some(x => x.includes('title')), 'present fields not flagged')
})

test('lintKb flags a type that disagrees with its directory, not a matching one', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/x.md'), 'raw')
  // type: source but placed in concepts/ — the indexer would file it under "Sources"
  // while its id/wikilinks say concepts/ (contract: concept↔concepts/).
  fs.writeFileSync(path.join(d, 'wiki/concepts/mismatch.md'),
    `---\ntype: source\ntitle: Mismatch\ndescription: d\ntags: [x]\nsources: [raw/x.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbody [[concepts/mismatch]]`)
  // a correctly-typed concept in the same dir must NOT be flagged
  fs.writeFileSync(path.join(d, 'wiki/concepts/ok.md'),
    `---\ntype: concept\ntitle: Ok\ndescription: d\ntags: [x]\nsources: [raw/x.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n---\n\nbody [[concepts/ok]]`)
  const r = await lintKb(d)
  const mismatches = r.mechanical.filter(i => i.rule === 'type-dir-mismatch')
  assert.deepEqual(mismatches.map(i => i.path), ['concepts/mismatch.md'], 'only the mismatched page is flagged')
  assert.match(mismatches[0].detail, /type "source" in concepts\/ \(expected "concept"\)/)
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

test('lintKb flags a page that supersedes itself (self is a real id, so target-missing would miss it)', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/r.md'), 'raw')
  // superseded_by points at the page itself: invalidated with no valid successor.
  fs.writeFileSync(path.join(d, 'wiki/concepts/loop.md'),
    `---\ntype: concept\ntitle: Loop\ndescription: d\ntags: [x]\nsources: [raw/r.md]\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: invalidated\nsuperseded_by: concepts/loop\n---\n\nbody [[concepts/other]]`)
  // a normal supersede to a real OTHER page must NOT be flagged as self-supersede
  fs.writeFileSync(path.join(d, 'wiki/concepts/other.md'),
    `---\ntype: concept\ntitle: Other\ndescription: d\ntags: [x]\nsources: [raw/r.md]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nbody [[concepts/loop]]`)
  const r = await lintKb(d)
  const self = r.mechanical.filter(i => i.rule === 'self-supersede')
  assert.deepEqual(self.map(i => i.path), ['concepts/loop.md'])
  assert.ok(!r.mechanical.some(i => i.rule === 'superseded-target-missing'), 'a self-supersede is not also target-missing (self id exists)')
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

test('contradiction-scan skips invalidated pages', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/a.md'), 'raw')
  const mk = (name, extra = '') => fs.writeFileSync(path.join(d, `wiki/entities/${name}.md`),
    `---\ntype: entity\ntitle: ${name}\ndescription: d\ntags: [shared]\nsources: [raw/a.md]\ncreated: 2026-07-09\nupdated: 2026-07-09\n${extra}---\n\nbody [[entities/${name}]]`)
  mk('live')
  mk('retired', 'status: invalidated\ninvalidated: 2026-07-10\n')
  const r = await lintKb(d)
  const cs = r.semantic.filter(s => s.task === 'contradiction-scan')
  // Only one live page carries tag "shared" once the invalidated one drops out,
  // so no 2+ cluster remains and the scan stays silent.
  assert.ok(!cs.some(s => s.detail.includes('tag "shared"')), 'invalidated page must not form a contradiction cluster')
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

test('stale-scan fires end-to-end after a source is changed and reconverted', async (t) => {
  const d = tmp(t)
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-src-'))
  t.after(() => fs.rmSync(src, { recursive: true, force: true }))
  initKb(d)
  fs.writeFileSync(path.join(src, 'doc.md'), '# Doc\noriginal ' + 'x'.repeat(100))
  await scanSource(src, d, {})
  await runConvertPlan(d)
  const raw = loadManifest(d).files['doc.md'].raw
  // page written against the first conversion, dated before today's reconvert
  fs.writeFileSync(path.join(d, 'wiki/sources/doc.md'),
    `---\ntype: source\ntitle: Doc\ndescription: d\ntags: [x]\nsources: [${raw}]\ncreated: 2000-01-01\nupdated: 2000-01-01\n---\n\nbody`)
  fs.writeFileSync(path.join(src, 'doc.md'), '# Doc\nrevised ' + 'y'.repeat(100))
  await scanSource(src, d, {})
  await runConvertPlan(d)
  const r = await lintKb(d)
  const stale = r.semantic.filter(s => s.task === 'stale-scan')
  assert.equal(stale.length, 1, 'reconversion of a cited source must surface as stale-scan')
  assert.match(stale[0].detail, /sources\/doc\.md/)
})

test('statusKb --src does not overwrite the saved scan plan', async (t) => {
  const d = tmp(t)
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-src-'))
  t.after(() => fs.rmSync(src, { recursive: true, force: true }))
  initKb(d)
  fs.writeFileSync(path.join(src, 'doc.md'), '# Doc\nbody')
  const sentinel = JSON.stringify({ marker: 'saved-by-explicit-scan' })
  fs.writeFileSync(path.join(d, '.scan-plan.json'), sentinel)
  const s = await statusKb(d, src)
  assert.ok(s.incremental, 'diff still computed')
  assert.equal(fs.readFileSync(path.join(d, '.scan-plan.json'), 'utf8'), sentinel, 'plan file untouched')
})

test('promote-concepts accepts hyphen and en-dash pending lines', async (t) => {
  const d = tmp(t)
  initKb(d)
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  fs.writeFileSync(path.join(d, 'wiki/index.md'), idx
    + '- multi-agent systems - [[sources/a]], [[sources/b]]\n'
    + '- retrieval – [[sources/a]], [[sources/b]]\n')
  const r = await lintKb(d)
  const promos = r.semantic.filter(s => s.task === 'promote-concepts')
  assert.ok(promos.some(s => s.detail.includes('multi-agent systems (2 sources)')), 'space-hyphen line counted, name kept intact')
  assert.ok(promos.some(s => s.detail.includes('retrieval (2 sources)')), 'en-dash line counted')
})

test('promote-concepts ignores list items in user sections after Pending', async (t) => {
  const d = tmp(t)
  initKb(d)
  const idx = fs.readFileSync(path.join(d, 'wiki/index.md'), 'utf8')
  fs.writeFileSync(path.join(d, 'wiki/index.md'), idx
    + '- real-pending — [[sources/a]], [[sources/b]]\n\n'
    + '## My notes\n- not-a-concept — [[sources/a]], [[sources/b]]\n')
  const r = await lintKb(d)
  const promos = r.semantic.filter(s => s.task === 'promote-concepts')
  assert.ok(promos.some(s => s.detail.includes('real-pending')))
  assert.ok(!promos.some(s => s.detail.includes('not-a-concept')), 'user-section item must not be treated as pending')
})

test('lint validates relations: entry shape, target existence, vocabulary, confidence', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/a.md'),
    `---\ntype: source\ntitle: A\ndescription: d\ntags: [x]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody [[sources/b]]`)
  fs.writeFileSync(path.join(d, 'wiki/sources/b.md'),
    `---\ntype: source\ntitle: B\ndescription: d\ntags: [x]\ncreated: 2026-07-01\nupdated: 2026-07-01\nrelations:\n  - to: sources/a\n    type: uses\n  - to: concepts/ghost\n    type: uses\n  - to: sources/a\n    type: invests_in\n  - to: sources/a\n    type: uses\n    confidence: banana\n  - just-a-string\n---\n\nbody`)
  const r = await lintKb(d)
  const rules = r.mechanical.map(i => i.rule)
  assert.ok(rules.includes('broken-relation-target'), 'ghost target reported')
  assert.ok(rules.includes('unknown-relation-type'), 'invests_in not in default vocabulary')
  assert.ok(rules.includes('invalid-relation-confidence'), 'banana confidence reported')
  assert.ok(rules.includes('invalid-relation-entry'), 'string entry reported')
  assert.ok(!r.mechanical.some(i => i.rule === 'unknown-relation-type' && i.detail.includes('"uses"')), 'in-vocabulary type not flagged')
})

test('relation targets count as incoming links for orphan detection', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/entities/lonely.md'),
    `---\ntype: entity\ntitle: Lonely\ndescription: d\ntags: [x]\nsources: [raw/a.md]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nno inbound wikilinks`)
  fs.writeFileSync(path.join(d, 'wiki/sources/citing.md'),
    `---\ntype: source\ntitle: Citing\ndescription: d\ntags: [x]\ncreated: 2026-07-01\nupdated: 2026-07-01\nrelations:\n  - to: entities/lonely\n    type: derived_from\n---\n\nbody`)
  fs.writeFileSync(path.join(d, 'raw/a.md'), 'raw')
  const r = await lintKb(d)
  assert.ok(!r.mechanical.some(i => i.rule === 'orphan-page' && i.path === 'entities/lonely.md'),
    'a page targeted by a typed relation is not an orphan')
})

test('lint tolerates a non-array relationTypes config override', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki.config.json'), '{"relationTypes": 5}')
  fs.writeFileSync(path.join(d, 'wiki/sources/a.md'),
    `---\ntype: source\ntitle: A\ndescription: d\ntags: [x]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody`)
  fs.writeFileSync(path.join(d, 'wiki/sources/b.md'),
    `---\ntype: source\ntitle: B\ndescription: d\ntags: [x]\ncreated: 2026-07-01\nupdated: 2026-07-01\nrelations:\n  - to: sources/a\n    type: uses\n---\n\nbody`)
  const r = await lintKb(d)
  assert.ok(r.mechanical.some(i => i.rule === 'unknown-relation-type' && i.path === 'sources/b.md'),
    'a non-array vocabulary reports every type as unknown instead of crashing')
})

test('lint flags duplicate relations (same to+type), noting conflicting confidence', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/a.md'),
    `---\ntype: source\ntitle: A\ndescription: d\ntags: [x]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody [[concepts/b]]`)
  fs.writeFileSync(path.join(d, 'wiki/concepts/b.md'),
    `---\ntype: concept\ntitle: B\ndescription: d\ntags: [x]\nsources: [raw/a.md]\ncreated: 2026-07-01\nupdated: 2026-07-01\nrelations:\n  - to: sources/a\n    type: uses\n    confidence: inferred\n  - to: sources/a\n    type: uses\n    confidence: ambiguous\n---\n\nbody`)
  fs.writeFileSync(path.join(d, 'raw/a.md'), 'raw')
  const r = await lintKb(d)
  const dup = r.mechanical.find(i => i.rule === 'duplicate-relation')
  assert.ok(dup, 'duplicate to+type reported')
  assert.match(dup.detail, /index keeps the first/)
  assert.match(dup.detail, /inferred.*ambiguous|conflicting/, 'conflicting confidence values named')
})

test('lint promote-concepts tolerates en-dash inside concept names', async (t) => {
  const d = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(d, 'wiki/sources/a.md'),
    `---\ntype: source\ntitle: A\ndescription: d\ntags: [x]\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nbody`)
  fs.appendFileSync(path.join(d, 'wiki/index.md'), '- pages 1–2 — [[sources/a]] [[sources/a]]\n')
  const r = await lintKb(d)
  const promo = r.semantic.find(s => s.task === 'promote-concepts')
  assert.ok(promo)
  assert.match(promo.detail, /^pages 1–2 /, 'name with en-dash captured whole, not truncated at the dash')
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
