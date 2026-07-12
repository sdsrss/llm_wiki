import fs from 'node:fs'
import path from 'node:path'

export const SUPPORTED_EXTS = ['.md', '.markdown', '.txt', '.html', '.htm', '.pdf', '.docx']

export function slugify(name) {
  const slug = name.toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  // A basename made entirely of emoji/symbols slugs to '' → a hidden `raw/.md`
  // dotfile that `status` skips (source silently dropped). Never return empty;
  // the caller's -N collision handler disambiguates untitled/untitled-2/…
  return slug || 'untitled'
}

function titleFrom(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

// A source can convert successfully yet yield no text — a scanned/image-only PDF, an
// empty DOCX, a blank .txt. That is still a converted page (markdown '' is not null, so
// the deliberate empty-file handling downstream is untouched), but writing a blank raw
// page while reporting "converted" silently misleads the user. Attach a warning the CLI
// can surface. `# heading`-prefixed HTML output never trims to empty, so this fires only
// on genuinely contentless extractions.
function result(markdown, title, warnings) {
  if (markdown !== null && markdown.trim() === '') {
    warnings.push('converted to an empty page — no extractable text (scanned/image-only PDF or empty document?)')
  }
  return { markdown, title, warnings }
}

export async function convertFile(srcPath) {
  const ext = path.extname(srcPath).toLowerCase()
  const base = path.basename(srcPath)
  const warnings = []
  try {
    if (ext === '.md' || ext === '.markdown') {
      const md = fs.readFileSync(srcPath, 'utf8')
      return result(md, titleFrom(md, base), warnings)
    }
    if (ext === '.txt') {
      const md = fs.readFileSync(srcPath, 'utf8')
      return result(md, titleFrom(md, base), warnings)
    }
    if (ext === '.html' || ext === '.htm') {
      const { JSDOM } = await import('jsdom')
      const { Readability } = await import('@mozilla/readability')
      const TurndownService = (await import('turndown')).default
      const html = fs.readFileSync(srcPath, 'utf8')
      const dom = new JSDOM(html, { url: 'https://local.invalid/' })
      const article = new Readability(dom.window.document).parse()
      if (!article?.content) {
        warnings.push('readability found no main content; skipped')
        return { markdown: null, title: base, warnings }
      }
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      const md = td.turndown(article.content)
      return result(`# ${article.title || base}\n\n${md}`, article.title || base, warnings)
    }
    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse')
      const { text } = await new PDFParse({ data: fs.readFileSync(srcPath) }).getText()
      return result(text, titleFrom(text, base), warnings)
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const { value } = await mammoth.extractRawText({ path: srcPath })
      return result(value, titleFrom(value, base), warnings)
    }
    warnings.push(`unsupported extension: ${ext}`)
    return { markdown: null, title: base, warnings }
  } catch (err) {
    warnings.push(`convert failed: ${err.message}`)
    return { markdown: null, title: base, warnings }
  }
}
