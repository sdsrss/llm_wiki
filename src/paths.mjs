import path from 'node:path'

export function kbPaths(root, config = {}) {
  const wiki = path.join(root, 'wiki')
  return {
    root,
    raw: path.join(root, config.rawDir ?? 'raw'),
    wiki,
    sources: path.join(wiki, 'sources'),
    entities: path.join(wiki, 'entities'),
    concepts: path.join(wiki, 'concepts'),
    comparisons: path.join(wiki, 'comparisons'),
    topics: path.join(wiki, 'topics'),
    indexMd: path.join(wiki, 'index.md'),
    logMd: path.join(wiki, 'log.md'),
    hotMd: path.join(wiki, 'hot.md'),
    graphJson: path.join(wiki, 'graph.json'),
    manifest: path.join(root, '.manifest.json'),
    scanPlan: path.join(root, '.scan-plan.json'),
    config: path.join(root, 'wiki.config.json'),
    schemaFile: path.join(root, config.schemaFile ?? 'AGENTS.md'),
    llmsTxt: path.join(root, 'llms.txt'),
    readme: path.join(root, 'README.md'),
  }
}
