import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { convertFile, slugify, SUPPORTED_EXTS } from '../src/convert.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('slugify keeps CJK, normalizes separators', () => {
  assert.equal(slugify('LLM Wiki 构建手册: v1/final'), 'llm-wiki-构建手册-v1-final')
})

test('md passes through, txt wraps, title from first heading', async (t) => {
  const d = tmp(t)
  fs.writeFileSync(path.join(d, 'a.md'), '# 标题甲\n\ncontent')
  const r = await convertFile(path.join(d, 'a.md'))
  assert.equal(r.title, '标题甲')
  assert.match(r.markdown, /content/)
})

test('html: readability strips nav/ads, keeps article text', async (t) => {
  const d = tmp(t)
  const html = `<html><head><title>Real Title</title></head><body>
    <nav>Home | About | ADS ADS ADS</nav>
    <div class="ad-banner">Buy now!!! Limited offer!!!</div>
    <article><h1>Real Title</h1>${'<p>Substantial article paragraph about knowledge compilation for language models.</p>'.repeat(8)}</article>
    <footer>copyright spam links</footer></body></html>`
  fs.writeFileSync(path.join(d, 'p.html'), html)
  const r = await convertFile(path.join(d, 'p.html'))
  assert.match(r.markdown, /knowledge compilation/)
  assert.ok(!/Buy now/.test(r.markdown), 'ad banner must be stripped')
})

test('txt branch: passes text through with title from first heading or basename', async (t) => {
  const d = tmp(t)
  fs.writeFileSync(path.join(d, 'note.txt'), '# 笔记标题\nplain body text')
  const r1 = await convertFile(path.join(d, 'note.txt'))
  assert.equal(r1.title, '笔记标题')
  assert.match(r1.markdown, /plain body text/)
  fs.writeFileSync(path.join(d, 'plain.txt'), 'no heading at all')
  const r2 = await convertFile(path.join(d, 'plain.txt'))
  assert.equal(r2.title, 'plain.txt', 'falls back to basename')
})

test('docx branch: extracts text via mammoth', async () => {
  const fixture = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'fixtures/hello.docx')
  const r = await convertFile(fixture)
  assert.equal(r.title, 'Hello docx')
  assert.match(r.markdown, /Body paragraph from a real docx fixture/)
  assert.equal(r.warnings.length, 0)
})

test('unsupported and broken files degrade gracefully', async (t) => {
  const d = tmp(t)
  fs.writeFileSync(path.join(d, 'x.xyz'), 'data')
  const r1 = await convertFile(path.join(d, 'x.xyz'))
  assert.equal(r1.markdown, null)
  assert.ok(r1.warnings.length > 0)
  fs.writeFileSync(path.join(d, 'broken.pdf'), 'not a real pdf')
  const r2 = await convertFile(path.join(d, 'broken.pdf'))
  assert.equal(r2.markdown, null)
  assert.ok(r2.warnings.length > 0)
  assert.ok(SUPPORTED_EXTS.includes('.pdf'))
})
