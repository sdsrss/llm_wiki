import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { initKb } from '../src/init.mjs'
import { scanSource, estimateTokens, worstCaseTokens } from '../src/scanner.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('estimateTokens: CJK counted ~1.6 chars/token, ascii ~4', () => {
  assert.ok(Math.abs(estimateTokens('测试中文内容啊'.repeat(10)) - 70 / 1.6) < 5)
  assert.ok(Math.abs(estimateTokens('a'.repeat(400)) - 100) < 5)
})

// R18 (audit): pessimistic budget estimate — ~2 chars/token ascii, ~1/char CJK —
// so dense pages don't overflow a small context window.
test('worstCaseTokens is pessimistic vs estimateTokens', () => {
  assert.equal(worstCaseTokens('a'.repeat(400)), 200) // 400 / 2, vs estimateTokens' ~100
  assert.equal(worstCaseTokens('中'.repeat(100)), 100) // 1 token / CJK char
  assert.ok(worstCaseTokens('x'.repeat(1000)) > estimateTokens('x'.repeat(1000)), 'always >= the nominal estimate')
})

test('scanSource flags a genuine near-duplicate that 32-perm minhash under-estimated (QA73-002)', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  // true Jaccard 0.898 — a near-dup a user would want flagged. At 32 perms the estimate
  // fell to 0.844 (< 0.85) and this pair was reported as `near: 0`; at the current perm
  // count it must be detected.
  const lines = Array.from({ length: 60 }, (_, i) => `sentence number ${i} about distributed systems and consensus protocols`)
  fs.writeFileSync(path.join(src, 'orig.md'), '# Doc\n' + lines.join('\n') + '\n')
  fs.writeFileSync(path.join(src, 'near.md'), '# Doc\n' + lines.join('\n') + '\nEXTRA trailing line added here only\n')
  const r = await scanSource(src, kb, {})
  assert.equal(r.duplicates.exact.length, 0, 'the pair is not an exact duplicate')
  assert.ok(r.duplicates.near.some(([a, b]) => [a, b].includes('orig.md') && [a, b].includes('near.md')),
    'a true-0.90 near-duplicate must be flagged, not missed')
})

test('scanSource: dedup, batching, plan file', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  // NOTE: body must be non-periodic — a repeated phrase yields ~16 distinct 5-char shingles,
  // where 32-perm minhash underestimates a true jaccard of 0.889 as 0.75 (< 0.85 threshold).
  const body = Array.from({ length: 50 }, (_, i) => `知识编译方法论正文内容第${i}节。`).join('')
  fs.writeFileSync(path.join(src, 'a.md'), '# A\n' + body)
  fs.writeFileSync(path.join(src, 'a-copy.md'), '# A\n' + body)          // exact dup
  fs.writeFileSync(path.join(src, 'a-near.md'), '# A\n' + body + '尾巴') // near dup
  fs.mkdirSync(path.join(src, 'sub'))
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(src, 'sub', `f${i}.md`), `# F${i}\n${'unique english content '.repeat(30)}${i}`)
  fs.writeFileSync(path.join(src, 'skip.bin'), 'binary')
  const r = await scanSource(src, kb, {})
  assert.equal(r.duplicates.exact.length, 1)
  assert.ok(r.duplicates.near.some(([a, b]) => [a, b].includes('a-near.md')))
  assert.ok(r.skipped.some(s => s.rel === 'skip.bin'))
  // unique compile set = a.md + a-near.md + 6 sub files = 8 -> 2 batches of 5
  const planned = r.batches.flat()
  assert.equal(planned.length, 8)
  assert.equal(r.batches.length, 2)
  assert.ok(r.estimate.inputTokens > r.estimate.contentTokens)
  assert.ok(fs.existsSync(path.join(kb, '.scan-plan.json')))
  // convert reads .scan-plan.json in a separate process — it must be written via
  // temp+rename (no leftover .tmp) so a concurrent read can't see a torn file.
  assert.ok(!fs.existsSync(path.join(kb, '.scan-plan.json.tmp')), 'plan written atomically, no leftover temp')
})

// ISSUE-002: bad srcDir used to leak a raw ENOENT/ENOTDIR node error.
test('scanSource: friendly error for a missing dir or a non-directory path', async (t) => {
  const kb = tmp(t)
  initKb(kb)
  await assert.rejects(() => scanSource(path.join(kb, 'no-such-dir'), kb, {}), /source directory not found:/)
  const f = path.join(kb, 'a-file.txt')
  fs.writeFileSync(f, 'x')
  await assert.rejects(() => scanSource(f, kb, {}), /source path is not a directory:/)
})

test('scanSource: symlinked dirs and escaping/broken file links are all reported as skipped', async (t) => {
  const src = tmp(t), kb = tmp(t), outside = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(outside, 'in-linked-dir.md'), '# Hidden\nbody')
  fs.writeFileSync(path.join(outside, 'linked-file.md'), '# Linked\nbody')
  fs.writeFileSync(path.join(src, 'plain.md'), '# Plain\nbody')
  fs.symlinkSync(outside, path.join(src, 'linked-dir'))
  fs.symlinkSync(path.join(outside, 'linked-file.md'), path.join(src, 'linked-file.md'))
  fs.symlinkSync(path.join(src, 'nowhere.md'), path.join(src, 'dangling.md'))
  const r = await scanSource(src, kb, {})
  assert.ok(r.skipped.some(s => s.rel === 'linked-dir' && s.reason.includes('symlinked directory')), 'dir symlink surfaces in skipped instead of vanishing')
  assert.ok(r.skipped.some(s => s.rel === 'dangling.md' && s.reason === 'broken symlink'))
  assert.ok(r.skipped.some(s => s.rel === 'linked-file.md' && s.reason === 'symlink escapes source dir'), 'file symlink pointing outside the tree is refused (HIGH-1)')
  assert.ok(!r.files.some(f => f.rel === 'linked-file.md'), 'escaping file symlink not scanned')
  assert.ok(!r.files.some(f => f.rel.includes('in-linked-dir')), 'linked dir contents not walked')
})

// HIGH-1 (audit v0.6.4): a symlinked file resolving OUTSIDE the source tree used
// to be read and copied into raw/ — an attacker-supplied corpus could exfiltrate
// ~/.llm-wiki/config.json (API key) or ~/.ssh/id_rsa into a publishable KB.
// It must now be skipped; an in-tree symlink is still followed; --follow-symlinks
// opts back into the old behavior.
test('scanSource: symlinked file escaping the source tree is refused (HIGH-1 exfiltration guard)', async (t) => {
  const src = tmp(t), kb = tmp(t), secretDir = tmp(t)
  initKb(kb)
  const secret = path.join(secretDir, 'config.json')
  fs.writeFileSync(secret, '{"apiKey":"sk-SECRET-should-never-be-ingested"}')
  fs.writeFileSync(path.join(src, 'real.md'), '# Real\nlegit body')
  fs.symlinkSync(path.join(src, 'real.md'), path.join(src, 'alias.md')) // in-tree symlink: allowed
  fs.symlinkSync(secret, path.join(src, 'notes.md'))                    // escapes tree: refused

  const r = await scanSource(src, kb, {})
  assert.ok(!r.files.some(f => f.rel === 'notes.md'), 'escaping symlink is NOT scanned')
  assert.ok(r.skipped.some(s => s.rel === 'notes.md' && s.reason === 'symlink escapes source dir'),
    'escaping symlink surfaces in skipped with a clear reason')
  assert.ok(r.files.some(f => f.rel === 'alias.md'), 'in-tree symlink is still followed')
  const planText = JSON.stringify(r)
  assert.ok(!planText.includes('sk-SECRET'), 'secret content never enters the scan report')

  const r2 = await scanSource(src, kb, { followSymlinks: true })
  assert.ok(r2.files.some(f => f.rel === 'notes.md'), '--follow-symlinks opts back into following escaping links')
})

// MEDIUM-1 (audit v0.6.4): unbounded reads OOM on a hostile large file. The cap is
// configurable via wiki.config.json; oversize files are skipped, not fatal.
test('scanSource: file over maxFileBytes is skipped with a clear reason', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(kb, 'wiki.config.json'), JSON.stringify({ maxFileBytes: 100 }))
  fs.writeFileSync(path.join(src, 'small.md'), '# ok\nshort')
  fs.writeFileSync(path.join(src, 'big.md'), '# big\n' + 'x'.repeat(500))
  const r = await scanSource(src, kb, {})
  assert.ok(r.files.some(f => f.rel === 'small.md'), 'under-cap file scanned')
  assert.ok(!r.files.some(f => f.rel === 'big.md'), 'over-cap file not scanned')
  assert.ok(r.skipped.some(s => s.rel === 'big.md' && /too large/.test(s.reason)), 'over-cap file surfaces in skipped')
})

test('scanSource --exclude skips matching paths with reason "excluded"', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, 'keep.md'), '# Keep\nbody')
  fs.mkdirSync(path.join(src, 'drafts'))
  fs.writeFileSync(path.join(src, 'drafts/wip.md'), '# WIP\nbody')
  fs.writeFileSync(path.join(src, 'notes-draft.md'), '# Draft\nbody')
  const r = await scanSource(src, kb, { exclude: ['draft'] })
  assert.deepEqual(r.files.map(f => f.rel), ['keep.md'])
  const excluded = r.skipped.filter(s => s.reason === 'excluded').map(s => s.rel).sort()
  assert.deepEqual(excluded, ['drafts/wip.md', 'notes-draft.md'], 'substring match applies to the full relative path')
})

test('symlinked directory matching --exclude is labeled excluded, not symlinked', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.mkdirSync(path.join(src, 'real-dir'))
  fs.writeFileSync(path.join(src, 'real-dir/x.md'), 'x')
  fs.writeFileSync(path.join(src, 'keep.md'), 'keep')
  fs.symlinkSync(path.join(src, 'real-dir'), path.join(src, 'skipme'), 'dir')
  const r = await scanSource(src, kb, { exclude: ['skipme'] })
  const entry = r.skipped.find(s => s.rel === 'skipme')
  assert.equal(entry?.reason, 'excluded')
})

test('scanSource: empty file gets lang en and zero tokens (no NaN path)', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, 'empty.md'), '')
  const r = await scanSource(src, kb, {})
  const e = r.files.find(f => f.rel === 'empty.md')
  assert.equal(e.lang, 'en')
  assert.equal(e.tokens, 0)
})

test('scanSource persist:false computes the report without writing the plan file', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  fs.writeFileSync(path.join(src, 'a.md'), '# A\nbody')
  const r = await scanSource(src, kb, { persist: false })
  assert.equal(r.files.length, 1)
  assert.ok(!fs.existsSync(path.join(kb, '.scan-plan.json')))
})

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'llm-wiki.mjs')

function writePage(kb, rel, tags, extra = '') {
  const abs = path.join(kb, 'wiki', rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---\ntype: concept\ntitle: ${path.basename(rel, '.md')}\ndescription: d\ntags: [${tags.join(', ')}]\ncreated: 2026-07-11\nupdated: 2026-07-11\n${extra}---\n\nbody\n`)
}

function writeMixedLangSrc(src) {
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(src, `zh${i}.md`), `# 中文${i}\n` + Array.from({ length: 10 }, (_, j) => `第${i}篇第${j}句中文正文内容。`).join(''))
    fs.writeFileSync(path.join(src, `en${i}.md`), `# En${i}\n` + Array.from({ length: 10 }, (_, j) => `english file ${i} sentence ${j} body text. `).join(''))
  }
}

test('scanSource: domainMixture flags mixed-language source, not a stray minority file', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  writeMixedLangSrc(src)
  const r = await scanSource(src, kb, {})
  assert.equal(r.domainMixture.language.zh, 5)
  assert.equal(r.domainMixture.language.en, 5)
  assert.equal(r.domainMixture.language.flagged, true)
  assert.equal(r.domainMixture.flagged, true)

  const src2 = tmp(t), kb2 = tmp(t)
  initKb(kb2)
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(src2, `zh${i}.md`), `# 中文${i}\n` + Array.from({ length: 10 }, (_, j) => `纯中文库第${i}篇第${j}句正文。`).join(''))
  fs.writeFileSync(path.join(src2, 'en0.md'), '# En\na single stray english file body text here')
  const r2 = await scanSource(src2, kb2, {})
  assert.equal(r2.domainMixture.language.flagged, false, 'minority of 1 file is below LANG_MIX_MIN_FILES')
  assert.equal(r2.domainMixture.flagged, false)
})

test('scanSource: domainMixture tag dispersion — >=10 tagged pages, low top-tag coverage, invalidated excluded', async (t) => {
  const src = tmp(t)
  fs.writeFileSync(path.join(src, 'a.md'), '# A\nsome plain body content here')

  const kb = tmp(t)
  initKb(kb)
  for (let i = 0; i < 12; i++) writePage(kb, `concepts/p${i}.md`, [`topic-${i}`])
  const r = await scanSource(src, kb, {})
  assert.equal(r.domainMixture.tags.pages, 12)
  assert.equal(r.domainMixture.tags.distinct, 12)
  assert.equal(r.domainMixture.tags.flagged, true)
  assert.equal(r.domainMixture.flagged, true)

  const kb2 = tmp(t)
  initKb(kb2)
  for (let i = 0; i < 12; i++) writePage(kb2, `concepts/p${i}.md`, ['shared', `topic-${i}`])
  const r2 = await scanSource(src, kb2, {})
  assert.equal(r2.domainMixture.tags.flagged, false, 'a tag shared by all pages means cohesive')
  assert.equal(r2.domainMixture.flagged, false)

  const kb3 = tmp(t)
  initKb(kb3)
  for (let i = 0; i < 9; i++) writePage(kb3, `concepts/p${i}.md`, [`topic-${i}`])
  writePage(kb3, 'concepts/dead.md', ['topic-dead'], 'status: invalidated\n')
  const r3 = await scanSource(src, kb3, {})
  assert.equal(r3.domainMixture.tags, null, 'invalidated page does not count toward the 10-page floor')
})

test('scanSource: tag flag agrees with the displayed rounded share at the 30% boundary', async (t) => {
  const src = tmp(t)
  fs.writeFileSync(path.join(src, 'a.md'), '# A\nplain body content here')
  // 8 of 27 pages share one tag: raw top-share 0.296 rounds to 0.30, which the
  // CLI prints as "30%". The flag must agree with that display (rule is <30%),
  // so it must NOT fire — a raw-value flag would have shown "covers 30%" while
  // flagged, the inconsistency this guards against.
  const kb = tmp(t)
  initKb(kb)
  for (let i = 0; i < 8; i++) writePage(kb, `concepts/s${i}.md`, ['shared'])
  for (let i = 0; i < 19; i++) writePage(kb, `concepts/u${i}.md`, [`topic-${i}`])
  const r = await scanSource(src, kb, {})
  assert.equal(r.domainMixture.tags.pages, 27)
  assert.equal(r.domainMixture.tags.topShare, 0.3, 'raw 8/27 = 0.296 stored rounded to 0.30')
  assert.equal(r.domainMixture.tags.flagged, false, 'displays "30%" so must not flag under the <30% rule')
})

test('scan CLI prints multi-domain warning when flagged, nothing when clean', async (t) => {
  const src = tmp(t), kb = tmp(t)
  initKb(kb)
  writeMixedLangSrc(src)
  const r = spawnSync(process.execPath, [BIN, 'scan', src, '--kb', kb], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /mixed-language source \(zh 5 \/ en 5 files\)/)
  assert.match(r.stdout, /one domain per KB/)

  const src2 = tmp(t), kb2 = tmp(t)
  initKb(kb2)
  fs.writeFileSync(path.join(src2, 'a.md'), '# A\nplain single language body content')
  const r2 = spawnSync(process.execPath, [BIN, 'scan', src2, '--kb', kb2], { encoding: 'utf8' })
  assert.equal(r2.status, 0)
  assert.ok(!r2.stdout.includes('warning:'), 'clean scan prints no domain warning')
})
