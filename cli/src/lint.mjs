import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { DEFAULT_CONFIG } from './templates.mjs'
import { listWikiPages, validatePage } from './pages.mjs'
import { extractWikilinks, buildIndex } from './indexer.mjs'

export async function lintKb(kbRoot, { fix = false } = {}) {
  const p = kbPaths(kbRoot)
  const cfg = fs.existsSync(p.config) ? { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(p.config, 'utf8')) } : DEFAULT_CONFIG
  const pages = listWikiPages(kbRoot)
  const mechanical = []
  const semantic = []
  const autoFixed = []
  const ids = new Set(pages.filter(pg => !pg.error).map(pg => pg.relPath.replace(/\.md$/, '')))
  const incoming = new Map()

  for (const pg of pages) {
    if (pg.error) { mechanical.push({ rule: 'invalid-frontmatter', path: pg.relPath, detail: pg.error }); continue }
    for (const issue of validatePage(pg)) mechanical.push({ rule: 'missing-field', path: pg.relPath, detail: issue })
    for (const target of extractWikilinks(pg.body)) {
      if (target.startsWith('raw/')) continue
      if (!ids.has(target)) mechanical.push({ rule: 'broken-wikilink', path: pg.relPath, detail: `-> ${target}` })
      else incoming.set(target, (incoming.get(target) ?? 0) + 1)
    }
    for (const src of pg.data.sources ?? []) {
      if (!fs.existsSync(path.join(kbRoot, String(src)))) mechanical.push({ rule: 'missing-raw-source', path: pg.relPath, detail: String(src) })
    }
  }
  for (const pg of pages) {
    if (pg.error) continue
    const id = pg.relPath.replace(/\.md$/, '')
    if (pg.data.type !== 'source' && !incoming.has(id)) mechanical.push({ rule: 'orphan-page', path: pg.relPath, detail: 'no incoming wikilinks' })
  }

  if (fs.existsSync(p.indexMd)) {
    const pendingSection = fs.readFileSync(p.indexMd, 'utf8').match(/## Pending concepts([\s\S]*)$/)?.[1] ?? ''
    for (const line of pendingSection.split('\n')) {
      const m = line.match(/^-\s*(.+?)\s*—/)
      if (!m) continue
      const refs = (line.match(/\[\[/g) ?? []).length
      if (refs >= cfg.conceptThreshold) semantic.push({ task: 'promote-concepts', detail: `${m[1]} (${refs} sources)` })
    }
  }
  const byTag = new Map()
  for (const pg of pages) {
    if (pg.error) continue
    for (const tag of pg.data.tags ?? []) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(pg.relPath)
    }
  }
  for (const [tag, list] of byTag) {
    if (list.length >= 2) semantic.push({ task: 'contradiction-scan', detail: `tag "${tag}": ${list.join(', ')}` })
  }

  if (fix) { buildIndex(kbRoot); autoFixed.push('index-rebuilt') }
  const report = { autoFixed, mechanical, semantic }
  fs.writeFileSync(path.join(kbRoot, '.lint-report.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
