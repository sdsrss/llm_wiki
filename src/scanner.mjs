import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { loadKbConfig } from './templates.mjs'
import { SUPPORTED_EXTS } from './convert.mjs'
import { sha256File, minhashSignature, jaccardEstimate } from './hashing.mjs'
import { loadManifest, diffManifest } from './manifest.mjs'
import { listWikiPages, isInvalidated } from './pages.mjs'
import { writeFileAtomic } from './json.mjs'

const TEXT_EXTS = ['.md', '.markdown', '.txt', '.html', '.htm']
const NEAR_DUP_THRESHOLD = 0.85
const LANG_MIX_MIN_FILES = 3
const LANG_MIX_MINORITY_SHARE = 0.25
const TAG_MIN_PAGES = 10
const TAG_TOP_SHARE_MIN = 0.3

// Advisory guardrail for the one-KB-per-domain rule, from signals scan already
// has: language mix across scanned text files, and tag dispersion across the
// built wiki (a cohesive KB has at least one tag most pages share). No LLM,
// no network; nothing blocks on it.
function detectDomainMixture(files, kbRoot) {
  const zh = files.filter(f => f.lang === 'zh').length
  const en = files.filter(f => f.lang === 'en').length
  const minority = Math.min(zh, en)
  const language = {
    zh,
    en,
    flagged: minority >= LANG_MIX_MIN_FILES && minority / (zh + en) >= LANG_MIX_MINORITY_SHARE,
  }
  let tags = null
  const pages = listWikiPages(kbRoot).filter(p =>
    !p.error && !isInvalidated(p) && Array.isArray(p.data.tags) && p.data.tags.length > 0)
  if (pages.length >= TAG_MIN_PAGES) {
    const counts = new Map()
    for (const p of pages) for (const t of new Set(p.data.tags)) counts.set(t, (counts.get(t) ?? 0) + 1)
    // Round once and flag on the rounded value so the stored/displayed share
    // (CLI prints Math.round(topShare*100)) never reads "30%" while the strict
    // `< TAG_TOP_SHARE_MIN` rule fired on a raw 0.29x. Effective threshold is
    // 29.5%; negligible for an advisory heuristic, and flag/display now agree.
    const topShare = Number((Math.max(...counts.values()) / pages.length).toFixed(2))
    tags = { pages: pages.length, distinct: counts.size, topShare, flagged: topShare < TAG_TOP_SHARE_MIN }
  }
  return { language, tags, flagged: language.flagged || (tags?.flagged ?? false) }
}

export function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[　-鿿豈-﫿]/.test(ch)) cjk++
  return Math.round(cjk / 1.6 + (text.length - cjk) / 4)
}

// Pessimistic token estimate for budgeting model input (ask). Dense markdown/code
// runs ~2-3.5 chars/BPE-token, so estimateTokens' chars/4 under-counts and can
// overflow a small context window; assume ~2 chars/token for non-CJK and ~1
// token/char for CJK. (Mirror of embed.mjs's local worstCaseEmbedTokens, which
// stays local by its own note; this is the shared budgeting copy.)
export function worstCaseTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[　-鿿豈-﫿]/.test(ch)) cjk++
  return Math.round(cjk + (text.length - cjk) / 2)
}

// Symlinked directories are not followed (loop safety) but are recorded in
// `skippedDirs` so they surface in the scan report instead of vanishing silently.
// Symlinked files are followed ONLY when their target resolves inside the source
// tree (`opts.rootReal`). A link escaping the tree would pull an arbitrary readable
// file (e.g. ~/.llm-wiki/config.json, ~/.ssh/id_rsa, /dev/zero) into raw/ and into a
// publishable page — the HIGH-1 exfiltration/DoS vector. `opts.followSymlinks` opts
// back into follow-anywhere for a trusted, curated corpus.
function* walk(dir, base, skippedDirs, exclude, opts) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const abs = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      const rel = path.relative(base, abs)
      if (exclude.some(pat => rel.includes(pat))) { skippedDirs.push({ rel, reason: 'excluded' }); continue }
      let st, real
      try { st = fs.statSync(abs); real = fs.realpathSync(abs) } catch { skippedDirs.push({ rel, reason: 'broken symlink' }); continue }
      if (st.isDirectory()) { skippedDirs.push({ rel, reason: 'symlinked directory (not followed)' }); continue }
      if (!opts.followSymlinks) {
        const relToRoot = path.relative(opts.rootReal, real)
        if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
          skippedDirs.push({ rel, reason: 'symlink escapes source dir' }); continue
        }
      }
      yield rel
    } else if (e.isDirectory()) yield* walk(abs, base, skippedDirs, exclude, opts)
    else yield path.relative(base, abs)
  }
}

// `persist: false` runs a read-only scan (e.g. for `status`) that does not
// overwrite the .scan-plan.json a previous explicit `scan` produced.
export async function scanSource(srcDir, kbRoot, { exclude = [], persist = true, followSymlinks = false } = {}) {
  const st = fs.statSync(srcDir, { throwIfNoEntry: false })
  if (!st) throw new Error(`source directory not found: ${srcDir}`)
  if (!st.isDirectory()) throw new Error(`source path is not a directory: ${srcDir}`)
  const cfg = loadKbConfig(kbRoot)
  const files = []
  const skipped = []
  const rootReal = fs.realpathSync(srcDir)
  for (const rel of walk(srcDir, srcDir, skipped, exclude, { followSymlinks, rootReal })) {
    if (exclude.some(pat => rel.includes(pat))) { skipped.push({ rel, reason: 'excluded' }); continue }
    const ext = path.extname(rel).toLowerCase()
    if (!SUPPORTED_EXTS.includes(ext)) { skipped.push({ rel, reason: `unsupported ${ext}` }); continue }
    const abs = path.join(srcDir, rel)
    const bytes = fs.statSync(abs).size
    // Size cap (audit MEDIUM-1): an unbounded read OOMs on a hostile multi-GB file;
    // gate before sha256File/readFileSync below, which both read the whole file.
    if (bytes > cfg.maxFileBytes) { skipped.push({ rel, reason: `too large (${bytes} bytes > ${cfg.maxFileBytes} cap)` }); continue }
    const entry = { rel, ext, bytes, hash: sha256File(abs), lang: 'unknown', tokens: 0 }
    if (TEXT_EXTS.includes(ext)) {
      const text = fs.readFileSync(abs, 'utf8')
      entry.tokens = estimateTokens(text)
      const sample = text.slice(0, 2000)
      let cjk = 0
      for (const ch of sample) if (/[　-鿿]/.test(ch)) cjk++
      // Explicit empty guard: 0/0 is NaN, which only accidentally compares as 'en'.
      entry.lang = sample.length > 0 && cjk / sample.length > 0.2 ? 'zh' : 'en'
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
    domainMixture: detectDomainMixture(files, kbRoot),
    batches,
    estimate,
  }
  // Atomic write: `convert` reads .scan-plan.json (runConvertPlan) as a separate
  // process, so a direct writeFileSync (truncate-then-write) could hand it a torn
  // file. Same torn-read class as buildIndex's derived stores.
  if (persist) writeFileAtomic(kbPaths(kbRoot).scanPlan, JSON.stringify(report, null, 2) + '\n')
  return report
}
