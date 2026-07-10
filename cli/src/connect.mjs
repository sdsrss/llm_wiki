import fs from 'node:fs'
import path from 'node:path'

const BEGIN = '<!-- llm-wiki:begin -->'
const END = '<!-- llm-wiki:end -->'

function renderBlock(kbs) {
  const lines = kbs.map(k =>
    `- role=${k.role} path=${k.path} — read ${k.path}/wiki/index.md first; ask via \`npx llm-wiki ask --kb ${k.path} "..."\``)
  return `${BEGIN}\n## Knowledge bases (managed by llm-wiki, do not edit)\n${lines.join('\n')}\n${END}`
}

export function connectProject(projectDir, { kb, role = 'project', remove = false }) {
  const regFile = path.join(projectDir, '.llm-wiki.json')
  const registry = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, 'utf8')) : { kbs: [] }
  // Match by resolved absolute path so `./kb`, `kb`, and the absolute form are one entry;
  // store the user-provided form verbatim (that is what gets rendered into CLAUDE.md).
  const same = (a, b) => path.resolve(projectDir, a) === path.resolve(projectDir, b)
  registry.kbs = registry.kbs.filter(k => !same(k.path, kb))
  if (!remove) registry.kbs.push({ path: kb, role })
  fs.writeFileSync(regFile, JSON.stringify(registry, null, 2) + '\n')

  const mdFile = path.join(projectDir, 'CLAUDE.md')
  const mdExists = fs.existsSync(mdFile)
  let md = mdExists ? fs.readFileSync(mdFile, 'utf8') : ''
  const blockRe = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`)
  md = md.replace(blockRe, '\n')
  if (registry.kbs.length > 0) md = md.trimEnd() + '\n\n' + renderBlock(registry.kbs) + '\n'
  if (mdExists || registry.kbs.length > 0) fs.writeFileSync(mdFile, md)
  return { registry }
}

export function installSkills(targetClaudeDir, repoSkillsDir) {
  const target = path.join(targetClaudeDir, 'skills')
  fs.mkdirSync(target, { recursive: true })
  const installed = []
  for (const name of fs.readdirSync(repoSkillsDir)) {
    const srcDir = path.join(repoSkillsDir, name)
    if (!fs.statSync(srcDir).isDirectory()) continue
    fs.cpSync(srcDir, path.join(target, name), { recursive: true })
    installed.push(name)
  }
  return { installed }
}
