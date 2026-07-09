import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { listWikiPages } from './pages.mjs'
import { scanSource } from './scanner.mjs'

export async function statusKb(kbRoot, srcDir) {
  const p = kbPaths(kbRoot)
  const referenced = new Set()
  for (const pg of listWikiPages(kbRoot)) {
    for (const src of pg.data?.sources ?? []) referenced.add(String(src))
  }
  const uncompiledRaw = []
  if (fs.existsSync(p.raw)) {
    for (const f of fs.readdirSync(p.raw)) {
      if (!f.endsWith('.md')) continue
      const rel = path.relative(kbRoot, path.join(p.raw, f))
      if (!referenced.has(rel)) uncompiledRaw.push(rel)
    }
  }
  let incremental = null
  if (srcDir) incremental = (await scanSource(srcDir, kbRoot, {})).incremental
  return { incremental, uncompiledRaw }
}
