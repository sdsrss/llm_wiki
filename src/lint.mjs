import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { loadKbConfig } from './templates.mjs'
import { listWikiPages, validatePage, isInvalidated, asList, PAGE_STATUSES, RELATION_CONFIDENCES } from './pages.mjs'
import { extractWikilinks, buildIndex } from './indexer.mjs'
import { loadManifest } from './manifest.mjs'
import { writeFileAtomic } from './json.mjs'

// The AGENTS.md contract binds each page type to its directory (source↔sources/, …).
// A page whose `type` disagrees with its directory is silently miscategorized: the
// indexer groups index.md sections by `type`, but ids / wikilinks / graph nodes use
// the directory — so e.g. a `type: source` page in concepts/ is filed under "Sources"
// yet linked as `concepts/…`.
const DIR_TYPE = { sources: 'source', entities: 'entity', concepts: 'concept', comparisons: 'comparison' }

export async function lintKb(kbRoot, { fix = false } = {}) {
  const p = kbPaths(kbRoot)
  const cfg = loadKbConfig(kbRoot)
  const pages = listWikiPages(kbRoot)
  const mechanical = []
  const semantic = []
  const autoFixed = []
  const ids = new Set(pages.filter(pg => !pg.error).map(pg => pg.relPath.replace(/\.md$/, '')))
  const incoming = new Map()

  for (const pg of pages) {
    if (pg.error) { mechanical.push({ rule: 'invalid-frontmatter', path: pg.relPath, detail: pg.error }); continue }
    for (const issue of validatePage(pg)) mechanical.push({ rule: 'missing-field', path: pg.relPath, detail: issue })
    // type must match the directory (AGENTS.md contract) — a mismatch is miscategorized
    // by the indexer. Skip when type is absent (already flagged as a missing field).
    const dir = pg.relPath.split('/')[0]
    if (DIR_TYPE[dir] && pg.data.type !== undefined && pg.data.type !== DIR_TYPE[dir]) {
      mechanical.push({ rule: 'type-dir-mismatch', path: pg.relPath, detail: `type "${pg.data.type}" in ${dir}/ (expected "${DIR_TYPE[dir]}")` })
    }
    for (const target of extractWikilinks(pg.body)) {
      if (target.startsWith('raw/')) {
        if (!fs.existsSync(path.join(kbRoot, target)) && !fs.existsSync(path.join(kbRoot, target + '.md'))) mechanical.push({ rule: 'broken-raw-link', path: pg.relPath, detail: `-> ${target}` })
        continue
      }
      if (!ids.has(target)) mechanical.push({ rule: 'broken-wikilink', path: pg.relPath, detail: `-> ${target}` })
      else incoming.set(target, (incoming.get(target) ?? 0) + 1)
    }
    for (const src of asList(pg.data.sources)) {
      if (!fs.existsSync(path.join(kbRoot, String(src)))) mechanical.push({ rule: 'missing-raw-source', path: pg.relPath, detail: String(src) })
    }
    if (pg.data.status !== undefined && !PAGE_STATUSES.includes(pg.data.status)) {
      mechanical.push({ rule: 'invalid-status', path: pg.relPath, detail: `status "${pg.data.status}" (expected ${PAGE_STATUSES.join(' | ')})` })
    }
    if (pg.data.superseded_by !== undefined) {
      const supTarget = String(pg.data.superseded_by)
      // A page cannot be its own replacement: superseded_by == self invalidates the page
      // with no valid successor (checked before target-missing, since the self id exists).
      if (supTarget === pg.relPath.replace(/\.md$/, '')) {
        mechanical.push({ rule: 'self-supersede', path: pg.relPath, detail: 'superseded_by points at itself' })
      } else if (!ids.has(supTarget)) {
        mechanical.push({ rule: 'superseded-target-missing', path: pg.relPath, detail: `superseded_by -> ${pg.data.superseded_by}` })
      }
    }
    if (pg.data.relations !== undefined && !Array.isArray(pg.data.relations)) {
      mechanical.push({ rule: 'invalid-relation-entry', path: pg.relPath, detail: 'relations must be a YAML list' })
    }
    const relationTypes = Array.isArray(cfg.relationTypes) ? cfg.relationTypes : []
    const seenRel = new Map()
    for (const rel of Array.isArray(pg.data.relations) ? pg.data.relations : []) {
      if (!rel || typeof rel !== 'object' || !rel.to || !rel.type) {
        mechanical.push({ rule: 'invalid-relation-entry', path: pg.relPath, detail: `expected {to, type[, confidence]}, got: ${JSON.stringify(rel)}` })
        continue
      }
      const target = String(rel.to).replace(/\.md$/, '')
      if (!ids.has(target)) mechanical.push({ rule: 'broken-relation-target', path: pg.relPath, detail: `-> ${target}` })
      else incoming.set(target, (incoming.get(target) ?? 0) + 1)
      if (!relationTypes.includes(String(rel.type))) {
        mechanical.push({ rule: 'unknown-relation-type', path: pg.relPath, detail: `"${rel.type}" not in relationTypes (${relationTypes.join(', ')})` })
      }
      if (rel.confidence !== undefined && !RELATION_CONFIDENCES.includes(rel.confidence)) {
        mechanical.push({ rule: 'invalid-relation-confidence', path: pg.relPath, detail: `"${rel.confidence}" (expected ${RELATION_CONFIDENCES.join(' | ')})` })
      }
      const key = `${target} ${rel.type}`
      const first = seenRel.get(key)
      if (first) {
        const conflict = first.confidence !== rel.confidence
          ? `, conflicting confidence "${first.confidence ?? 'inferred'}" vs "${rel.confidence ?? 'inferred'}"`
          : ''
        mechanical.push({ rule: 'duplicate-relation', path: pg.relPath, detail: `-> ${target} type "${rel.type}" duplicated (index keeps the first entry)${conflict}` })
      } else {
        seenRel.set(key, rel)
      }
    }
  }
  for (const pg of pages) {
    if (pg.error) continue
    const id = pg.relPath.replace(/\.md$/, '')
    if (pg.data.type !== 'source' && pg.data.type !== 'comparison' && !isInvalidated(pg) && !incoming.has(id)) mechanical.push({ rule: 'orphan-page', path: pg.relPath, detail: 'no incoming wikilinks or relations' })
  }

  if (fs.existsSync(p.indexMd)) {
    // Bounded at the next `## ` heading (same rule as buildIndex) so entries in
    // user-added sections after Pending are not counted as pending concepts.
    const pendingSection = fs.readFileSync(p.indexMd, 'utf8').match(/## Pending concepts([\s\S]*?)(?=\n## |$)/)?.[1] ?? ''
    for (const line of pendingSection.split('\n')) {
      // Dash flavors: em/en dash separator requires a trailing space, or a
      // space-delimited hyphen (`- foo - [[a]]`) — a bare `-` would stop inside
      // hyphenated names like multi-agent, and a spaceless en-dash (`pages 1–2`)
      // is part of the name, not a separator.
      const m = line.match(/^-\s*(.+?)(?:\s*[—–]\s|\s+-\s)/)
      if (!m) continue
      const refs = (line.match(/\[\[/g) ?? []).length
      if (refs >= cfg.conceptThreshold) semantic.push({ task: 'promote-concepts', detail: `${m[1]} (${refs} sources)` })
    }
  }
  const byTag = new Map()
  for (const pg of pages) {
    // Invalidated pages are retired knowledge: they must drop out of the semantic
    // worklist just like stale-scan (below) and the orphan rule already do, so the
    // agent is never asked to reconcile a "contradiction" against a dead page.
    if (pg.error || isInvalidated(pg)) continue
    for (const tag of asList(pg.data.tags)) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(pg.relPath)
    }
  }
  for (const [tag, list] of byTag) {
    // Only flag small shared-tag clusters: 2-5 pages are plausible contradiction candidates.
    // Larger groups are navigation/topic tags (one tag on dozens of pages) — unactionable noise.
    if (list.length >= 2 && list.length <= 5) semantic.push({ task: 'contradiction-scan', detail: `tag "${tag}": ${list.join(', ')}` })
  }

  // stale-scan: a raw file reconverted after a page's last update means the page may
  // describe an outdated version of its source. Deterministic candidate generation;
  // the LLM judges whether the page actually needs updating (STALE benchmark: LLMs
  // detect staleness unaided at only ~55% accuracy — never rely on spontaneous detection).
  const manifest = loadManifest(kbRoot)
  const convertedAtByRaw = new Map()
  for (const entry of Object.values(manifest.files)) {
    if (entry.raw && entry.convertedAt) convertedAtByRaw.set(entry.raw, entry.convertedAt)
  }
  for (const pg of pages) {
    if (pg.error || isInvalidated(pg)) continue
    const updated = String(pg.data.updated ?? '')
    if (!updated) continue
    for (const src of asList(pg.data.sources)) {
      const conv = convertedAtByRaw.get(String(src))
      if (conv && conv > updated) semantic.push({ task: 'stale-scan', detail: `${pg.relPath}: ${src} reconverted ${conv}, page updated ${updated}` })
    }
  }

  if (fix) { buildIndex(kbRoot); autoFixed.push('index-rebuilt') }
  const report = { autoFixed, mechanical, semantic }
  // Atomic write for uniformity with the other JSON state files (temp+rename). The
  // report has no in-process reader today, so this is preventive, not a live torn-read.
  writeFileAtomic(path.join(kbRoot, '.lint-report.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
