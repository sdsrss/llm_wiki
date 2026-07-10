import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const cyEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")

// graph.json only lists wiki pages as nodes, but source-type edges point at raw/
// paths. Exports need every edge endpoint to exist, so synthesize raw nodes.
export function loadGraph(kbRoot) {
  const p = kbPaths(kbRoot)
  if (!fs.existsSync(p.graphJson)) throw new Error('wiki/graph.json not found — run `llm-wiki index` first.')
  const graph = JSON.parse(fs.readFileSync(p.graphJson, 'utf8'))
  const ids = new Set(graph.nodes.map(n => n.id))
  for (const e of graph.edges) {
    for (const end of [e.source, e.target]) {
      if (!ids.has(end)) {
        ids.add(end)
        graph.nodes.push({ id: end, type: 'raw', title: path.basename(end) })
      }
    }
  }
  return graph
}

export function toGraphML(graph) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="d0" for="node" attr.name="type" attr.type="string"/>',
    '  <key id="d1" for="node" attr.name="title" attr.type="string"/>',
    '  <key id="d2" for="node" attr.name="status" attr.type="string"/>',
    '  <key id="d3" for="edge" attr.name="type" attr.type="string"/>',
    '  <graph id="llm_wiki" edgedefault="directed">',
  ]
  for (const n of graph.nodes) {
    lines.push(`    <node id="${xmlEscape(n.id)}">`)
    lines.push(`      <data key="d0">${xmlEscape(n.type ?? '')}</data>`)
    lines.push(`      <data key="d1">${xmlEscape(n.title ?? '')}</data>`)
    if (n.status) lines.push(`      <data key="d2">${xmlEscape(n.status)}</data>`)
    lines.push('    </node>')
  }
  graph.edges.forEach((e, i) => {
    lines.push(`    <edge id="e${i}" source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}"><data key="d3">${xmlEscape(e.type ?? '')}</data></edge>`)
  })
  lines.push('  </graph>', '</graphml>')
  return lines.join('\n') + '\n'
}

export function toCypher(graph) {
  const label = (t) => ({ source: 'Source', entity: 'Entity', concept: 'Concept', comparison: 'Comparison', raw: 'Raw' })[t] ?? 'Page'
  const lines = graph.nodes.map(n =>
    `MERGE (n:${label(n.type)} {id: '${cyEscape(n.id)}'}) SET n.title = '${cyEscape(n.title ?? '')}'${n.status ? `, n.status = '${cyEscape(n.status)}'` : ''};`)
  for (const e of graph.edges) {
    const rel = String(e.type ?? 'link').replace(/[^a-zA-Z_]/g, '_').toUpperCase()
    lines.push(`MATCH (a {id: '${cyEscape(e.source)}'}), (b {id: '${cyEscape(e.target)}'}) MERGE (a)-[:${rel}]->(b);`)
  }
  return lines.join('\n') + '\n'
}

const RENDERERS = { graphml: toGraphML, cypher: toCypher }

export function exportGraph(kbRoot, { format, out } = {}) {
  const render = RENDERERS[format]
  if (!render) throw new Error(`unknown format: ${format} (expected ${Object.keys(RENDERERS).join(' | ')})`)
  const graph = loadGraph(kbRoot)
  const outPath = out ?? path.join(kbRoot, `graph.${format === 'graphml' ? 'graphml' : format === 'cypher' ? 'cypher' : 'html'}`)
  fs.writeFileSync(outPath, render(graph))
  return { out: outPath, nodeCount: graph.nodes.length, edgeCount: graph.edges.length }
}
