import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { listWikiPages } from './pages.mjs'
import { scanSource } from './scanner.mjs'
import { loadManifest, diffManifest } from './manifest.mjs'

// Recursively collect *.md files under a raw/ tree so hand-organized subdirectories
// are visible. Skips the `_originals` staging dir and any dotfiles/dotdirs.
function collectRawMd(dir, kbRoot, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === '_originals') continue
      collectRawMd(full, kbRoot, out)
    } else if (ent.name.endsWith('.md')) {
      out.push(path.relative(kbRoot, full))
    }
  }
}

export async function statusKb(kbRoot, srcDir) {
  const p = kbPaths(kbRoot)
  const referenced = new Set()
  const pagesByRaw = new Map()
  for (const pg of listWikiPages(kbRoot)) {
    if (pg.error) continue
    const id = pg.relPath.replace(/\.md$/, '')
    for (const src of pg.data.sources ?? []) {
      const raw = String(src)
      referenced.add(raw)
      if (!pagesByRaw.has(raw)) pagesByRaw.set(raw, [])
      pagesByRaw.get(raw).push(id)
    }
  }
  const uncompiledRaw = []
  if (fs.existsSync(p.raw)) {
    const rawFiles = []
    collectRawMd(p.raw, kbRoot, rawFiles)
    for (const rel of rawFiles) {
      if (!referenced.has(rel)) uncompiledRaw.push(rel)
    }
  }
  let incremental = null
  const affectedPages = []
  if (srcDir) {
    const manifest = loadManifest(kbRoot)
    // Read-only scan: status must not clobber the plan an explicit `scan` saved.
    // (The diff itself still scans everything — it does not replay the saved
    // plan's --exclude patterns, so excluded files can appear in affectedPages.)
    const report = await scanSource(srcDir, kbRoot, { persist: false })
    incremental = report.incremental
    const diff = diffManifest(manifest, report.files.map(f => ({ rel: f.rel, hash: f.hash })))
    const entry = (e, kind) => {
      const rel = typeof e === 'string' ? e : e.rel
      const raw = manifest.files[rel]?.raw ?? null
      return { src: rel, kind, raw, pages: raw ? (pagesByRaw.get(raw) ?? []) : [] }
    }
    for (const e of diff.changed) affectedPages.push(entry(e, 'changed'))
    for (const rel of diff.removed) affectedPages.push(entry(rel, 'removed'))
  }
  return { incremental, uncompiledRaw, affectedPages }
}
