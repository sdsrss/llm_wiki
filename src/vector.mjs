import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { readJsonFile } from './json.mjs'

export function normalize(vec) {
  let s = 0
  for (const x of vec) s += x * x
  if (!(s > 0)) return null
  const n = Math.sqrt(s)
  return vec.map(x => x / n)
}

// Same fields BM25 indexes (src/ask.mjs retrievePages) so both channels see one text.
export function pageEmbedText(pg) {
  return [pg.data.title ?? '', pg.data.description ?? '', (pg.data.tags ?? []).join(' '), pg.body].join('\n')
}

export function vectorStorePath(kbRoot) {
  return path.join(kbPaths(kbRoot).wiki, '.vectors.json')
}

export function loadVectorStore(kbRoot) {
  const f = vectorStorePath(kbRoot)
  if (!fs.existsSync(f)) return null
  let s
  try { s = readJsonFile(f) } catch (err) {
    // Fail open: a corrupt derived store must never take down `ask` — vector
    // location silently degrades to BM25 (mem #10032 posture).
    process.stderr.write(`warning: ignoring corrupt vector store (${err.message}) — run \`llm-wiki embed\` to rebuild\n`)
    return null
  }
  return (s && typeof s.pages === 'object') ? s : null
}

export function saveVectorStore(kbRoot, store) {
  const rounded = { ...store, pages: Object.fromEntries(Object.entries(store.pages).map(([id, e]) =>
    [id, { hash: e.hash, vec: e.vec.map(x => Number(x.toFixed(5))) }])) }
  // Atomic write: the per-batch flush in embedKb re-saves repeatedly; a crash
  // mid-write must not leave a truncated store (loadVectorStore fails open, but
  // temp+rename avoids the corruption entirely).
  const f = vectorStorePath(kbRoot)
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rounded) + '\n')
  fs.renameSync(tmp, f)
}

// queryVec must already be normalized; stored vecs are normalized at save time,
// so the dot product IS the cosine similarity.
export function cosineTopK(queryVec, store, k) {
  const out = []
  for (const [id, { vec }] of Object.entries(store.pages)) {
    if (vec.length !== queryVec.length) continue
    let dot = 0
    for (let i = 0; i < vec.length; i++) dot += vec[i] * queryVec[i]
    if (dot > 0) out.push({ id, score: dot })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k)
}
