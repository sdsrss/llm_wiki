import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { convertFile, slugify } from './convert.mjs'
import { loadManifest, saveManifest } from './manifest.mjs'

function uniquePath(dir, slug) {
  let candidate = path.join(dir, `${slug}.md`)
  let n = 2
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${slug}-${n++}.md`)
  return candidate
}

export async function runConvertPlan(kbRoot) {
  const p = kbPaths(kbRoot)
  const plan = JSON.parse(fs.readFileSync(p.scanPlan, 'utf8'))
  const manifest = loadManifest(kbRoot)
  const byRel = new Map(plan.files.map(f => [f.rel, f]))
  const converted = []
  const failed = []
  fs.mkdirSync(p.raw, { recursive: true })
  for (const rel of plan.batches.flat()) {
    const srcAbs = path.join(plan.srcDir, rel)
    const entry = byRel.get(rel)
    const { markdown, warnings } = await convertFile(srcAbs)
    if (markdown === null) { failed.push({ src: rel, warnings }); continue }
    const rawAbs = uniquePath(p.raw, slugify(path.basename(rel)))
    fs.writeFileSync(rawAbs, markdown)
    const ext = path.extname(rel).toLowerCase()
    if (ext !== '.md' && ext !== '.markdown') {
      const origDir = path.join(p.raw, '_originals')
      fs.mkdirSync(origDir, { recursive: true })
      fs.copyFileSync(srcAbs, path.join(origDir, path.basename(rel)))
    }
    const rawRel = path.relative(kbRoot, rawAbs)
    manifest.files[rel] = { hash: entry.hash, raw: rawRel, convertedAt: new Date().toISOString().slice(0, 10) }
    converted.push({ src: rel, raw: rawRel })
  }
  saveManifest(kbRoot, manifest)
  return { converted, failed }
}
