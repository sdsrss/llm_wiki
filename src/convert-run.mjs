import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { convertFile, slugify } from './convert.mjs'
import { loadManifest, saveManifest } from './manifest.mjs'
import { readJsonFile } from './json.mjs'

function uniquePath(dir, slug) {
  let candidate = path.join(dir, `${slug}.md`)
  let n = 2
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${slug}-${n++}.md`)
  return candidate
}

function uniqueOriginalPath(dir, base) {
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  let candidate = path.join(dir, base)
  let n = 2
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}-${n++}${ext}`)
  return candidate
}

export async function runConvertPlan(kbRoot) {
  const p = kbPaths(kbRoot)
  if (!fs.existsSync(p.scanPlan)) throw new Error(`${p.scanPlan} not found — run \`llm-wiki scan\` first.`)
  const plan = readJsonFile(p.scanPlan)
  if (!Array.isArray(plan?.files) || !Array.isArray(plan?.batches) || typeof plan?.srcDir !== 'string') {
    throw new Error(`${p.scanPlan}: unexpected shape (needs files/batches/srcDir) — re-run \`llm-wiki scan\`.`)
  }
  const manifest = loadManifest(kbRoot)
  const byRel = new Map(plan.files.map(f => [f.rel, f]))
  const converted = []
  const failed = []
  fs.mkdirSync(p.raw, { recursive: true })
  for (const rel of plan.batches.flat()) {
    const srcAbs = path.join(plan.srcDir, rel)
    const entry = byRel.get(rel)
    // A hand-edited or stale plan can list a batch entry with no files record;
    // surface it as a failed conversion instead of a bare TypeError below.
    if (!entry) { failed.push({ src: rel, warnings: ['not in the scan plan file list — re-run `llm-wiki scan`'] }); continue }
    const { markdown, warnings } = await convertFile(srcAbs)
    if (markdown === null) { failed.push({ src: rel, warnings }); continue }
    // Re-converting a changed source overwrites its previous raw file in place.
    // A fresh uniquePath here would orphan the old raw file AND break lint's
    // stale-scan (pages cite the old raw path, the manifest would point at the new one).
    const prev = manifest.files[rel]
    const rawAbs = prev?.raw && fs.existsSync(path.join(kbRoot, prev.raw))
      ? path.join(kbRoot, prev.raw)
      : uniquePath(p.raw, slugify(path.basename(rel)))
    fs.writeFileSync(rawAbs, markdown)
    const ext = path.extname(rel).toLowerCase()
    let originalRel
    if (ext !== '.md' && ext !== '.markdown') {
      const origDir = path.join(p.raw, '_originals')
      fs.mkdirSync(origDir, { recursive: true })
      // Same-basename sources from different dirs must not clobber each other's
      // originals; a re-convert reuses the path recorded in the manifest.
      const origAbs = prev?.original && fs.existsSync(path.join(kbRoot, prev.original))
        ? path.join(kbRoot, prev.original)
        : uniqueOriginalPath(origDir, path.basename(rel))
      fs.copyFileSync(srcAbs, origAbs)
      originalRel = path.relative(kbRoot, origAbs)
    }
    const rawRel = path.relative(kbRoot, rawAbs)
    manifest.files[rel] = {
      hash: entry.hash,
      raw: rawRel,
      convertedAt: new Date().toISOString().slice(0, 10),
      ...(originalRel ? { original: originalRel } : {}),
    }
    converted.push({ src: rel, raw: rawRel })
  }
  saveManifest(kbRoot, manifest)
  return { converted, failed }
}
