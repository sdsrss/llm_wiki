import YAML from 'yaml'

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FM_OPEN_RE = /^---\r?\n/

export function parseFrontmatter(text) {
  const m = text.match(FM_RE)
  if (!m) {
    // Opens with a `---` delimiter but never closes it — an unterminated block, not
    // an absent one. A forgotten closing `---` is a common authoring slip; report it
    // distinctly so the fix is "close the frontmatter", not "add frontmatter".
    if (FM_OPEN_RE.test(text)) return { error: 'unterminated-frontmatter' }
    return null
  }
  let data
  try { data = YAML.parse(m[1]) } catch { return { error: 'invalid-yaml' } }
  if (data === null || typeof data !== 'object') return { error: 'invalid-yaml' }
  return { data, body: text.slice(m[0].length) }
}
