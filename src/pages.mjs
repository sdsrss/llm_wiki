import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { parseFrontmatter } from './frontmatter.mjs'

const PAGE_DIRS = ['sources', 'entities', 'concepts', 'comparisons']
const REQUIRED = ['type', 'title', 'description', 'tags', 'created', 'updated']

export const PAGE_STATUSES = ['active', 'invalidated']

export const RELATION_CONFIDENCES = ['extracted', 'inferred', 'ambiguous']

// A frontmatter list field (tags, sources) authored as a bare scalar — `tags: cache`
// instead of `tags: [cache]` — is parsed by YAML as a string. That silently passes a
// `?? []` guard and then crashes `.join()` (retrieval/embed) or iterates the string
// character-by-character (lint noise, and indexer synthesizing a bogus graph edge per
// char). Every consumer routes list fields through this so one malformed page cannot
// DoS retrieval or corrupt the graph; validatePage/lint still flag the bad shape.
export const asList = (v) => (Array.isArray(v) ? v : [])

export function isInvalidated(page) {
  return page.data?.status === 'invalidated'
}

export function listWikiPages(kbRoot) {
  const p = kbPaths(kbRoot)
  const pages = []
  for (const dir of PAGE_DIRS) {
    const abs = path.join(p.wiki, dir)
    if (!fs.existsSync(abs)) continue
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.md')) continue
      const fileAbs = path.join(abs, f)
      const text = fs.readFileSync(fileAbs, 'utf8')
      const fm = parseFrontmatter(text)
      if (fm === null) pages.push({ relPath: `${dir}/${f}`, abs: fileAbs, data: {}, body: text, error: 'missing-frontmatter' })
      else if (fm.error) pages.push({ relPath: `${dir}/${f}`, abs: fileAbs, data: {}, body: text, error: fm.error })
      else pages.push({ relPath: `${dir}/${f}`, abs: fileAbs, data: fm.data, body: fm.body })
    }
  }
  return pages
}

export function validatePage(page) {
  const issues = []
  if (page.error) return [page.error]
  for (const k of REQUIRED) {
    if (page.data[k] === undefined || page.data[k] === null || page.data[k] === '') issues.push(`missing field: ${k}`)
  }
  if (!Array.isArray(page.data.sources)) issues.push('missing field: sources (evidence chain)')
  // tags is caught as present by the REQUIRED loop above even when authored as a
  // bare scalar (`tags: cache`); flag the wrong shape explicitly so the author fixes
  // it rather than silently getting a page with no searchable tags.
  if (page.data.tags !== undefined && !Array.isArray(page.data.tags)) issues.push('tags must be a YAML list')
  return issues
}
