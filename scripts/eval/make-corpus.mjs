#!/usr/bin/env node
// Build a synthetic KB tier from local markdown (default: node_modules docs).
// Usage: node scripts/eval/make-corpus.mjs --tier 50 [--src node_modules] [--out scripts/eval/corpus/kb-50]
// Zero network. Deterministic given the same source tree (lockfile-pinned).
import fs from 'node:fs'
import path from 'node:path'
import { buildIndex } from '../../src/indexer.mjs'
import { estimateTokens } from '../../src/scanner.mjs'

const MIN_BYTES = 1024
const CORPUS_DATE = '2026-07-11' // fixed: corpora must be byte-reproducible

export function pickFiles(paths, tier) {
  const sorted = [...paths].sort()
  if (sorted.length < tier) throw new Error(`only ${sorted.length} candidate files for tier ${tier} — need at least ${tier}`)
  const step = Math.floor(sorted.length / tier)
  const picked = []
  for (let i = 0; picked.length < tier && i < sorted.length; i += step) picked.push(sorted[i])
  return picked.slice(0, tier)
}

export function wrapPage(relPath, content) {
  const noExt = relPath.replace(/^node_modules\//, '').replace(/\.md$/i, '')
  const slug = noExt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const lines = content.split('\n')
  const heading = lines.find(l => /^#\s+\S/.test(l))
  const title = heading ? heading.replace(/^#\s+/, '').trim() : path.basename(noExt)
  const para = content.split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#') && !s.startsWith('```') && !s.startsWith('<'))
  const description = (para ?? '').replace(/\s+/g, ' ').slice(0, 200)
  const tag = noExt.split('/')[0]
  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'type: concept',
    `tags: [${JSON.stringify(tag)}]`,
    `description: ${JSON.stringify(description)}`,
    `updated: ${CORPUS_DATE}`,
    '---',
  ].join('\n')
  return { slug, text: `${fm}\n\n${content}` }
}

// ---- CLI (skipped when imported by tests) ----
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/eval/make-corpus.mjs')) {
  const args = process.argv.slice(2)
  const opt = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1] }
  const tier = Number.parseInt(opt('--tier', ''), 10)
  if (!Number.isInteger(tier) || tier <= 0) { console.error('--tier <n> is required (e.g. 50, 150)'); process.exit(1) }
  const src = opt('--src', 'node_modules')
  const out = opt('--out', `scripts/eval/corpus/kb-${tier}`)

  const candidates = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && /\.md$/i.test(e.name) && fs.statSync(p).size >= MIN_BYTES) candidates.push(p)
    }
  }
  walk(src)
  const picked = pickFiles(candidates, tier)

  const wikiDir = path.join(out, 'wiki', 'concepts')
  fs.rmSync(path.join(out, 'wiki'), { recursive: true, force: true })
  fs.mkdirSync(wikiDir, { recursive: true })
  fs.mkdirSync(path.join(out, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(out, 'wiki.config.json'), '{\n  "vectorEnabled": true\n}\n')
  const seen = new Set()
  let bodyTokens = 0
  for (const file of picked) {
    const content = fs.readFileSync(file, 'utf8')
    let { slug, text } = wrapPage(path.relative(process.cwd(), file), content)
    let n = 2
    while (seen.has(slug)) slug = `${slug}-${n++}`
    seen.add(slug)
    fs.writeFileSync(path.join(wikiDir, `${slug}.md`), text)
    bodyTokens += estimateTokens(text)
  }
  const r = buildIndex(out)
  // index.md lives under wiki/, but buildIndex writes llms.txt at the KB root.
  const idxTokens = [path.join(out, 'wiki', 'index.md'), path.join(out, 'llms.txt')].reduce(
    (a, p) => a + (fs.existsSync(p) ? estimateTokens(fs.readFileSync(p, 'utf8')) : 0), 0)
  console.log(`tier ${tier}: ${seen.size} pages → ${out}`)
  console.log(`page tokens (est): ${bodyTokens} | index tokens (index.md + llms.txt, est): ${idxTokens} | indexed pages: ${r.pageCount ?? seen.size}`)
  console.log(`next: npx llm-wiki embed --kb ${out}   (for vector/hybrid arms)`)
}
