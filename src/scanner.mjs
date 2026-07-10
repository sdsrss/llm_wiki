import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { loadKbConfig } from './templates.mjs'
import { SUPPORTED_EXTS } from './convert.mjs'
import { sha256File, minhashSignature, jaccardEstimate } from './hashing.mjs'
import { loadManifest, diffManifest } from './manifest.mjs'

const TEXT_EXTS = ['.md', '.markdown', '.txt', '.html', '.htm']
const NEAR_DUP_THRESHOLD = 0.85

export function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[　-鿿豈-﫿]/.test(ch)) cjk++
  return Math.round(cjk / 1.6 + (text.length - cjk) / 4)
}

// Symlinked directories are not followed (loop safety) but are recorded in
// `skippedDirs` so they surface in the scan report instead of vanishing silently.
// Symlinked files keep working: reads below follow the link as before.
function* walk(dir, base = dir, skippedDirs = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const abs = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      let st
      try { st = fs.statSync(abs) } catch { skippedDirs.push({ rel: path.relative(base, abs), reason: 'broken symlink' }); continue }
      if (st.isDirectory()) { skippedDirs.push({ rel: path.relative(base, abs), reason: 'symlinked directory (not followed)' }); continue }
      yield path.relative(base, abs)
    } else if (e.isDirectory()) yield* walk(abs, base, skippedDirs)
    else yield path.relative(base, abs)
  }
}

// `persist: false` runs a read-only scan (e.g. for `status`) that does not
// overwrite the .scan-plan.json a previous explicit `scan` produced.
export async function scanSource(srcDir, kbRoot, { exclude = [], persist = true } = {}) {
  const cfg = loadKbConfig(kbRoot)
  const files = []
  const skipped = []
  for (const rel of walk(srcDir, srcDir, skipped)) {
    if (exclude.some(pat => rel.includes(pat))) { skipped.push({ rel, reason: 'excluded' }); continue }
    const ext = path.extname(rel).toLowerCase()
    if (!SUPPORTED_EXTS.includes(ext)) { skipped.push({ rel, reason: `unsupported ${ext}` }); continue }
    const abs = path.join(srcDir, rel)
    const bytes = fs.statSync(abs).size
    const entry = { rel, ext, bytes, hash: sha256File(abs), lang: 'unknown', tokens: 0 }
    if (TEXT_EXTS.includes(ext)) {
      const text = fs.readFileSync(abs, 'utf8')
      entry.tokens = estimateTokens(text)
      let cjk = 0
      for (const ch of text.slice(0, 2000)) if (/[　-鿿]/.test(ch)) cjk++
      entry.lang = cjk / Math.min(text.length, 2000) > 0.2 ? 'zh' : 'en'
      // Near-dup guard: minhash of very short normalized text degenerates to an
      // all-zero signature, making unrelated tiny files compare as identical.
      // Only sign when the normalized text is long enough to yield 5-char shingles.
      const norm = text.toLowerCase().replace(/\s+/g, ' ')
      if (norm.length >= 5) entry._sig = minhashSignature(text)
    } else {
      entry.tokens = Math.round(bytes / 6) // rough for binary formats until converted
    }
    files.push(entry)
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))

  const exact = []
  const byHash = new Map()
  for (const f of files) {
    if (byHash.has(f.hash)) exact.push([byHash.get(f.hash).rel, f.rel])
    else byHash.set(f.hash, f)
  }
  const exactDups = new Set(exact.map(([, dup]) => dup))

  const near = []
  const uniques = files.filter(f => !exactDups.has(f.rel) && f._sig)
  for (let i = 0; i < uniques.length; i++) {
    for (let j = i + 1; j < uniques.length; j++) {
      const sim = jaccardEstimate(uniques[i]._sig, uniques[j]._sig)
      if (sim >= NEAR_DUP_THRESHOLD) near.push([uniques[i].rel, uniques[j].rel, Number(sim.toFixed(2))])
    }
  }

  const diff = diffManifest(loadManifest(kbRoot), files.map(f => ({ rel: f.rel, hash: f.hash })))
  const toCompileSet = new Set([...diff.added, ...diff.changed].map(e => e.rel))
  const toCompile = files.filter(f => toCompileSet.has(f.rel) && !exactDups.has(f.rel))
  const batches = []
  for (let i = 0; i < toCompile.length; i += cfg.batchSize) {
    batches.push(toCompile.slice(i, i + cfg.batchSize).map(f => f.rel))
  }
  const contentTokens = toCompile.reduce((s, f) => s + f.tokens, 0)
  const estimate = {
    contentTokens,
    inputTokens: Math.round(contentTokens * 2 + 4000 * batches.length),
    outputTokens: Math.round(contentTokens * 0.35),
  }
  const report = {
    srcDir: path.resolve(srcDir),
    files: files.map(({ _sig, ...f }) => f),
    skipped,
    duplicates: { exact, near },
    incremental: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, unchanged: diff.unchanged.length },
    batches,
    estimate,
  }
  if (persist) fs.writeFileSync(kbPaths(kbRoot).scanPlan, JSON.stringify(report, null, 2) + '\n')
  return report
}
