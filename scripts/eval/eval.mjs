#!/usr/bin/env node
// Usage: node scripts/eval/eval.mjs --kb ./kb [--probes scripts/eval/probes-kb.jsonl] [--arms bm25,vector,hybrid] [-k 5]
// bm25 arm needs no network. vector/hybrid need wiki/.vectors.json (run `llm-wiki embed`)
// plus an embeddingModel in ~/.llm-wiki/config.json.
import fs from 'node:fs'
import path from 'node:path'
import { retrievePages, rrfFuse } from '../../src/ask.mjs'
import { loadVectorStore, normalize, cosineTopK } from '../../src/vector.mjs'
import { embedTexts } from '../../src/embed.mjs'
import { loadLlmConfig, makeTransport } from '../../src/llm-config.mjs'
import { listWikiPages } from '../../src/pages.mjs'
import { recallAtK, mrr, summarize } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1] }
const kb = opt('--kb', './kb')
const probesFile = opt('--probes', 'scripts/eval/probes-kb.jsonl')
const arms = opt('--arms', 'bm25').split(',')
const k = Number.parseInt(opt('-k', '5'), 10)

const probes = fs.readFileSync(probesFile, 'utf8').split('\n').filter(Boolean).map((l, i) => {
  try { return JSON.parse(l) } catch { console.error(`probes line ${i + 1}: invalid JSON`); process.exit(1) }
})
const validIds = new Set(listWikiPages(kb).filter(p => !p.error).map(p => p.relPath.replace(/\.md$/, '')))
for (const p of probes) {
  if (!p.q || !Array.isArray(p.expect) || p.expect.length === 0) { console.error(`bad probe: ${JSON.stringify(p)}`); process.exit(1) }
  for (const id of p.expect) if (!validIds.has(id)) { console.error(`probe expects unknown page id: ${id}`); process.exit(1) }
}

const needVec = arms.some(a => a !== 'bm25')
let store = null, cfg = null, t = null
if (needVec) {
  store = loadVectorStore(kb)
  cfg = loadLlmConfig(kb)
  if (!store) { console.error('vector/hybrid arms need wiki/.vectors.json — run `llm-wiki embed --kb ' + kb + '` first'); process.exit(1) }
  if (!cfg?.embeddingModel) { console.error('vector/hybrid arms need embeddingModel in ~/.llm-wiki/config.json'); process.exit(1) }
  t = await makeTransport()
}

const strip = (relPath) => relPath.replace(/\.md$/, '')
const rows = []
for (const p of probes) {
  let qn = null
  if (needVec) {
    const [qv] = await embedTexts(cfg, t, [p.q])
    qn = normalize(qv)
  }
  for (const arm of arms) {
    const t0 = performance.now()
    let got
    if (arm === 'bm25') got = retrievePages(kb, p.q, k).map(h => strip(h.relPath))
    else if (arm === 'vector') got = (qn ? cosineTopK(qn, store, k) : []).map(h => strip(h.id))
    else if (arm === 'hybrid') {
      const bm = retrievePages(kb, p.q, k)
      const vec = (qn ? cosineTopK(qn, store, k) : []).map(v => ({ relPath: v.id }))
      got = rrfFuse([{ source: 'bm25', hits: bm }, { source: 'vector', hits: vec }], k).map(h => strip(h.relPath))
    } else { console.error(`unknown arm: ${arm}`); process.exit(1) }
    const ms = performance.now() - t0
    rows.push({ arm, probe: p.q, lang: p.lang ?? '?', recall: recallAtK(p.expect, got, k), mrr: mrr(p.expect, got), ms, got })
  }
}

const resultsDir = 'scripts/eval/results'
fs.mkdirSync(resultsDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outFile = path.join(resultsDir, `eval-${stamp}.jsonl`)
fs.writeFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n')

const s = summarize(rows)
console.log(`\n| arm | n | Recall@${k} | MRR | avg ms |`)
console.log('|---|---|---|---|---|')
for (const [arm, m] of Object.entries(s)) {
  console.log(`| ${arm} | ${m.n} | ${m.recall.toFixed(3)} | ${m.mrr.toFixed(3)} | ${m.avgMs.toFixed(1)} |`)
}
console.log(`\ndetail: ${outFile}`)
