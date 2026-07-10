import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { parseFrontmatter } from './frontmatter.mjs'

const PAGE_DIRS = ['sources', 'entities', 'concepts', 'comparisons']
const REQUIRED = ['type', 'title', 'description', 'tags', 'created', 'updated']

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
  return issues
}
