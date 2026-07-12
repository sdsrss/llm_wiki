#!/usr/bin/env node
// Usage: node scripts/eval/eval.mjs --kb ./kb [--probes scripts/eval/probes-kb.jsonl] [--arms bm25,vector,hybrid,auto,graph] [-k 5]
// bm25 arm needs no network. vector/hybrid/auto need wiki/.vectors.json (run `llm-wiki embed`)
// plus an embeddingModel in ~/.llm-wiki/config.json. `auto` mirrors the production default
// (BM25 + vector fused, with the cross-language lexical-disjoint guard applied per the KB's
// wiki.config.json `lexicalGuard`); `hybrid` is always-fuse (guard off).
import fs from 'node:fs'
import path from 'node:path'
import { retrievePages, rrfFuse, fuseChannels } from '../../src/ask.mjs'
import { loadVectorStore, normalize, cosineTopK } from '../../src/vector.mjs'
import { embedTexts } from '../../src/embed.mjs'
import { loadEmbedConfig, makeTransport } from '../../src/llm-config.mjs'
import { loadKbConfig } from '../../src/templates.mjs'
import { listWikiPages, isInvalidated } from '../../src/pages.mjs'
import { readJsonFile } from '../../src/json.mjs'
import { recallAtK, mrr, summarize, degreeRank } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1] }
const kb = opt('--kb', './kb')
const probesFile = opt('--probes', 'scripts/eval/probes-kb.jsonl')
const arms = opt('--arms', 'bm25').split(',')
const k = Number.parseInt(opt('-k', '5'), 10)
// Read the KB's real guard setting so the `auto` arm reflects config plumbing, not a
// hardcoded flag (production wiring is in src/ask.mjs locatePages; unit tests cover it).
const lexicalGuard = loadKbConfig(kb).lexicalGuard

const probes = fs.readFileSync(probesFile, 'utf8').split('\n').filter(Boolean).map((l, i) => {
  try { return JSON.parse(l) } catch { console.error(`probes line ${i + 1}: invalid JSON`); process.exit(1) }
})
const PROBE_TYPES = ['fact', 'multihop', 'xlang', 'none']
const validIds = new Set(listWikiPages(kb).filter(p => !p.error && !isInvalidated(p)).map(p => p.relPath.replace(/\.md$/, '')))
for (const p of probes) {
  const type = p.type ?? 'fact'
  if (!p.q || !Array.isArray(p.expect) || !PROBE_TYPES.includes(type)) {
    console.error(`bad probe: ${JSON.stringify(p)}`); process.exit(1)
  }
  if (type === 'none' ? p.expect.length !== 0 : p.expect.length === 0) {
    console.error(`probe type "${type}" has ${p.expect.length ? 'a non-empty' : 'an empty'} expect: ${JSON.stringify(p)}`); process.exit(1)
  }
  for (const id of p.expect) if (!validIds.has(id)) { console.error(`probe expects unknown page id: ${id}`); process.exit(1) }
}
const retrievalProbes = probes.filter(p => (p.type ?? 'fact') !== 'none')
if (retrievalProbes.length < probes.length) {
  console.error(`note: ${probes.length - retrievalProbes.length} "none" probes skipped — retrieval metrics are undefined for them; run answer-eval.mjs for abstention`)
}

const needVec = arms.some(a => a !== 'bm25')
let store = null, cfg = null, t = null
if (needVec) {
  store = loadVectorStore(kb)
  // loadEmbedConfig (not loadLlmConfig): a local: embeddingModel resolves with no chat
  // creds, so the local-embedded C9 corpus this tooling targets can actually be evaluated.
  cfg = loadEmbedConfig(kb)
  if (!store) { console.error('vector/hybrid arms need wiki/.vectors.json — run `llm-wiki embed --kb ' + kb + '` first'); process.exit(1) }
  if (!cfg?.embeddingModel) { console.error('vector/hybrid arms need an embeddingModel in ~/.llm-wiki/config.json (a local: model needs no chat creds)'); process.exit(1) }
  t = await makeTransport()
}

let graphData = null
if (arms.includes('graph')) {
  const gPath = path.join(kb, 'wiki', 'graph.json')
  if (!fs.existsSync(gPath)) { console.error(`graph arm needs ${gPath} — run \`llm-wiki index\` first`); process.exit(1) }
  graphData = readJsonFile(gPath)
  if (!Array.isArray(graphData.edges) || graphData.edges.length === 0) {
    console.error('graph arm: graph.json has no edges — this arm is meaningless on a linkless corpus'); process.exit(1)
  }
}

const strip = (relPath) => relPath.replace(/\.md$/, '')
const rows = []
for (const p of retrievalProbes) {
  let qn = null
  if (needVec) {
    const [qv] = await embedTexts(cfg, t, [p.q], { role: 'query' })
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
    } else if (arm === 'auto') {
      const bm = retrievePages(kb, p.q, k)
      const vec = (qn ? cosineTopK(qn, store, k) : []).map(v => ({ relPath: v.id }))
      got = fuseChannels({ bm25: bm, vector: vec }, k, { lexicalGuard }).hits.map(h => strip(h.relPath))
    } else if (arm === 'graph') {
      const bm = retrievePages(kb, p.q, k)
      const vec = (qn ? cosineTopK(qn, store, k) : []).map(v => ({ relPath: v.id }))
      const candidates = [...new Map([...bm, ...vec].map(h => [h.relPath, h])).values()]
      const deg = degreeRank(graphData, candidates.map(h => strip(h.relPath))).map(id => ({ relPath: `${id}.md` }))
      got = rrfFuse([
        { source: 'bm25', hits: bm },
        { source: 'vector', hits: vec },
        { source: 'graph', hits: deg },
      ], k).map(h => strip(h.relPath))
    } else { console.error(`unknown arm: ${arm}`); process.exit(1) }
    const ms = performance.now() - t0
    rows.push({ arm, probe: p.q, lang: p.lang ?? '?', type: p.type ?? 'fact', recall: recallAtK(p.expect, got, k), mrr: mrr(p.expect, got), ms, got })
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

console.log(`\n| arm | type | n | Recall@${k} | MRR |`)
console.log('|---|---|---|---|---|')
for (const [arm, m] of Object.entries(s)) {
  for (const [ty, tm] of Object.entries(m.byType)) {
    console.log(`| ${arm} | ${ty} | ${tm.n} | ${tm.recall.toFixed(3)} | ${tm.mrr.toFixed(3)} |`)
  }
}
console.log(`\ndetail: ${outFile}`)
