import YAML from 'yaml'

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseFrontmatter(text) {
  const m = text.match(FM_RE)
  if (!m) return null
  let data
  try { data = YAML.parse(m[1]) } catch { return { error: 'invalid-yaml' } }
  if (data === null || typeof data !== 'object') return { error: 'invalid-yaml' }
  return { data, body: text.slice(m[0].length) }
}

export function serializeFrontmatter(data, body) {
  return `---\n${YAML.stringify(data)}---\n\n${body.replace(/^\n+/, '')}`
}
