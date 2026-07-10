import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { listWikiPages } from './pages.mjs'
import { scanSource } from './scanner.mjs'

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
  for (const pg of listWikiPages(kbRoot)) {
    for (const src of pg.data?.sources ?? []) referenced.add(String(src))
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
  if (srcDir) incremental = (await scanSource(srcDir, kbRoot, {})).incremental
  return { incremental, uncompiledRaw }
}
