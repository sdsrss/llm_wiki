import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { listWikiPages } from './pages.mjs'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

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

// Wikilink → standard-markdown-link conversion for tools that don't support
// wikilinks (design doc §5: export-only — the wiki/ main format never changes).
// fromDir is the exporting file's directory relative to the wiki root ('' for
// index.md), so targets become correct relative paths. Known limitation:
// wikilink-shaped text inside code fences is converted too — page bodies are
// prose distilled from documents, not code, so this is acceptable.
const WIKILINK_CONVERT_RE = /\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

export function wikilinksToMarkdown(body, fromDir = '') {
  return body.replace(WIKILINK_CONVERT_RE, (m, target, anchor, label) => {
    const t = target.trim().replace(/\.md$/, '')
    if (t === '') {
      // anchor-only link ([[#h]]) → same-page heading link; degenerate [[]] left as-is
      if (!anchor) return m
      return `[${label || anchor.slice(1)}](${anchor})`
    }
    const rel = path.relative(fromDir, `${t}.md`).split(path.sep).join('/')
    return `[${label || t}](${rel}${anchor ?? ''})`
  })
}

// Marker file that certifies a directory as an llm-wiki export we own and may
// wipe. Cleaning on re-export keeps the copy a faithful mirror (deleted/renamed
// pages don't leave stale files); the marker guard prevents blind-rm of an
// arbitrary user-supplied --out path.
const EXPORT_MARKER = '.llm-wiki-export'

export function exportMarkdownPages(kbRoot, { out } = {}) {
  const p = kbPaths(kbRoot)
  const outDir = path.resolve(out ?? path.join(kbRoot, 'wiki-md'))
  // Never let --out resolve onto a managed KB layer: the marker guard below would
  // later rmSync it, wiping the immutable raw/ inputs or the wiki/ pages themselves.
  const forbidden = [path.resolve(kbRoot), path.resolve(kbRoot, 'raw'), path.resolve(p.wiki)]
  if (forbidden.includes(outDir)) {
    throw new Error(`refusing to export into the KB's managed layers (${path.relative(kbRoot, outDir) || '.'}) — pass a dedicated --out directory`)
  }
  if (fs.existsSync(outDir) && !fs.statSync(outDir).isDirectory()) {
    throw new Error(`--out must be a directory, got a file: ${outDir}`)
  }
  const marker = path.join(outDir, EXPORT_MARKER)
  if (fs.existsSync(outDir)) {
    if (fs.existsSync(marker)) fs.rmSync(outDir, { recursive: true, force: true })
    else if (fs.readdirSync(outDir).length > 0) {
      throw new Error(`refusing to overwrite non-empty ${outDir} (not an llm-wiki export dir — pass an empty or new --out)`)
    }
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(marker, JSON.stringify({ tool: '@sdsrs/llm-wiki', version: pkg.version }) + '\n')
  let pageCount = 0
  const writeConverted = (srcAbs, relPath) => {
    const dest = path.join(outDir, relPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const fromDir = path.dirname(relPath) === '.' ? '' : path.dirname(relPath)
    fs.writeFileSync(dest, wikilinksToMarkdown(fs.readFileSync(srcAbs, 'utf8'), fromDir))
    pageCount++
  }
  for (const pg of listWikiPages(kbRoot)) writeConverted(pg.abs, pg.relPath)
  if (fs.existsSync(p.indexMd)) writeConverted(p.indexMd, 'index.md')
  if (fs.existsSync(p.topics)) {
    for (const f of fs.readdirSync(p.topics)) {
      if (f.endsWith('.md')) writeConverted(path.join(p.topics, f), `topics/${f}`)
    }
  }
  return { out: outDir, pageCount }
}

export function toGraphML(graph) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="d0" for="node" attr.name="type" attr.type="string"/>',
    '  <key id="d1" for="node" attr.name="title" attr.type="string"/>',
    '  <key id="d2" for="node" attr.name="status" attr.type="string"/>',
    '  <key id="d3" for="edge" attr.name="type" attr.type="string"/>',
    '  <key id="d4" for="edge" attr.name="confidence" attr.type="string"/>',
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
    const conf = e.confidence ? `<data key="d4">${xmlEscape(e.confidence)}</data>` : ''
    lines.push(`    <edge id="e${i}" source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}"><data key="d3">${xmlEscape(e.type ?? '')}</data>${conf}</edge>`)
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
    const set = e.confidence ? ` SET r.confidence = '${cyEscape(e.confidence)}'` : ''
    lines.push(`MATCH (a {id: '${cyEscape(e.source)}'}), (b {id: '${cyEscape(e.target)}'}) MERGE (a)-[r:${rel}]->(b)${set};`)
  }
  return lines.join('\n') + '\n'
}

export function toHtml(graph) {
  // <-escape keeps any "</script>" inside titles from terminating the script block.
  const data = JSON.stringify({ nodes: graph.nodes, edges: graph.edges }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>llm_wiki graph</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; color: #ddd; font: 12px system-ui, sans-serif; }
  #legend { position: fixed; top: 8px; left: 8px; background: #000a; padding: 6px 10px; border-radius: 6px; }
  #legend span { margin-right: 10px; }
  canvas { display: block; }
</style>
</head>
<body>
<div id="legend"></div>
<canvas id="c"></canvas>
<script>
const GRAPH = ${data}
const COLORS = { source: '#4e9af1', entity: '#5fbf77', concept: '#c98bdb', comparison: '#e0b25c', raw: '#777' }
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')
let W, H
function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight }
resize(); addEventListener('resize', resize)

document.getElementById('legend').innerHTML = Object.entries(COLORS)
  .map(([t, c]) => '<span><b style="color:' + c + '">●</b> ' + t + '</span>').join('')
  + '<span>◌ invalidated</span><span>drag: pan · wheel: zoom</span>'

const nodes = GRAPH.nodes.map((n, i) => ({
  ...n,
  x: Math.cos(i * 2.399963) * (60 + 14 * Math.sqrt(i)),
  y: Math.sin(i * 2.399963) * (60 + 14 * Math.sqrt(i)),
  vx: 0, vy: 0,
}))
const byId = new Map(nodes.map(n => [n.id, n]))
const edges = GRAPH.edges.map(e => ({ ...e, a: byId.get(e.source), b: byId.get(e.target) })).filter(e => e.a && e.b)

let scale = Math.min(2, 500 / (60 + 14 * Math.sqrt(nodes.length))), ox = 0, oy = 0
let dragging = false, px = 0, py = 0, hover = null
canvas.onmousedown = (e) => { dragging = true; px = e.clientX; py = e.clientY }
onmouseup = () => { dragging = false }
onmousemove = (e) => {
  if (dragging) { ox += e.clientX - px; oy += e.clientY - py; px = e.clientX; py = e.clientY; return }
  const mx = (e.clientX - W / 2 - ox) / scale, my = (e.clientY - H / 2 - oy) / scale
  hover = null
  for (const n of nodes) if ((n.x - mx) ** 2 + (n.y - my) ** 2 < 100) { hover = n; break }
}
canvas.onwheel = (e) => { e.preventDefault(); scale *= e.deltaY < 0 ? 1.1 : 0.9 }

let ticks = 0
function step() {
  if (ticks++ < 300) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      let dx = a.x - b.x, dy = a.y - b.y
      const d2 = dx * dx + dy * dy || 1
      const f = Math.min(1200 / d2, 4)
      dx *= f / Math.sqrt(d2); dy *= f / Math.sqrt(d2)
      a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d - 60) * 0.01
      e.a.vx += dx / d * f; e.a.vy += dy / d * f
      e.b.vx -= dx / d * f; e.b.vy -= dy / d * f
    }
    for (const n of nodes) { n.vx *= 0.85; n.vy *= 0.85; n.x += n.vx; n.y += n.vy }
  }
  ctx.clearRect(0, 0, W, H)
  ctx.save()
  ctx.translate(W / 2 + ox, H / 2 + oy)
  ctx.scale(scale, scale)
  ctx.strokeStyle = '#444'
  for (const e of edges) {
    ctx.setLineDash(e.type === 'superseded_by' ? [4, 3] : [])
    ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke()
  }
  ctx.setLineDash([])
  for (const n of nodes) {
    ctx.fillStyle = COLORS[n.type] ?? '#aaa'
    ctx.beginPath(); ctx.arc(n.x, n.y, n.type === 'raw' ? 3 : 6, 0, 7); ctx.fill()
    if (n.status === 'invalidated') {
      ctx.strokeStyle = '#e05c5c'; ctx.setLineDash([2, 2])
      ctx.beginPath(); ctx.arc(n.x, n.y, 9, 0, 7); ctx.stroke(); ctx.setLineDash([])
    }
  }
  ctx.fillStyle = '#ddd'
  if (scale > 0.8) for (const n of nodes) if (n.type !== 'raw') ctx.fillText(n.title ?? n.id, n.x + 8, n.y + 3)
  if (hover) { ctx.font = 'bold 12px system-ui'; ctx.fillStyle = '#fff'; ctx.fillText(hover.id + (hover.status ? ' [' + hover.status + ']' : ''), hover.x + 8, hover.y - 8); ctx.font = '12px system-ui' }
  ctx.restore()
  requestAnimationFrame(step)
}
step()
</script>
</body>
</html>
`
}

const RENDERERS = { graphml: toGraphML, cypher: toCypher, html: toHtml }

export function exportGraph(kbRoot, { format, out } = {}) {
  const render = RENDERERS[format]
  if (!render) throw new Error(`unknown format: ${format} (expected ${Object.keys(RENDERERS).join(' | ')} | markdown)`)
  const graph = loadGraph(kbRoot)
  const outPath = out ?? path.join(kbRoot, `graph.${format === 'graphml' ? 'graphml' : format === 'cypher' ? 'cypher' : 'html'}`)
  fs.writeFileSync(outPath, render(graph))
  return { out: outPath, nodeCount: graph.nodes.length, edgeCount: graph.edges.length }
}
