// Pure traversal over the graph.json shape ({ nodes, edges }) — zero LLM, zero I/O.
// Callers load the graph via loadGraph() (export.mjs), which synthesizes raw nodes
// so every edge endpoint exists. Traversal is undirected (a backlink is as real a
// connection as a forward link); each hop reports the edge's original direction.

export function buildAdjacency(graph) {
  const adj = new Map(graph.nodes.map(n => [n.id, []]))
  for (const e of graph.edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source).push({ id: e.target, dir: 'out', type: e.type, confidence: e.confidence })
    adj.get(e.target).push({ id: e.source, dir: 'in', type: e.type, confidence: e.confidence })
  }
  return adj
}

function assertNode(adj, id) {
  if (!adj.has(id)) throw new Error(`unknown node: ${id} (page ids come from graph.json — rerun \`llm-wiki index\` if it is stale)`)
}

export function shortestPath(graph, from, to) {
  const adj = buildAdjacency(graph)
  assertNode(adj, from)
  assertNode(adj, to)
  if (from === to) return { nodes: [from], hops: [] }
  const prev = new Map([[from, null]])
  const queue = [from]
  while (queue.length) {
    const cur = queue.shift()
    for (const nb of adj.get(cur)) {
      if (prev.has(nb.id)) continue
      prev.set(nb.id, { id: cur, via: nb })
      if (nb.id === to) {
        const hops = []
        for (let at = to; prev.get(at); at = prev.get(at).id) {
          const { id, via } = prev.get(at)
          hops.unshift({ from: id, to: at, type: via.type, confidence: via.confidence, dir: via.dir })
        }
        return { nodes: [from, ...hops.map(h => h.to)], hops }
      }
      queue.push(nb.id)
    }
  }
  return null
}

export function neighborhood(graph, id, depth = 1) {
  const adj = buildAdjacency(graph)
  assertNode(adj, id)
  const seen = new Set([id])
  const out = []
  let frontier = [id]
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = []
    for (const cur of frontier) {
      for (const nb of adj.get(cur)) {
        if (seen.has(nb.id)) continue
        seen.add(nb.id)
        out.push({ id: nb.id, distance: d, type: nb.type, confidence: nb.confidence, dir: nb.dir })
        next.push(nb.id)
      }
    }
    frontier = next
  }
  return out
}

export function hubs(graph, { top = 10 } = {}) {
  const deg = new Map()
  const bump = (id, key) => {
    const cur = deg.get(id) ?? { in: 0, out: 0 }
    cur[key]++
    deg.set(id, cur)
  }
  for (const e of graph.edges) {
    bump(e.source, 'out')
    bump(e.target, 'in')
  }
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  return [...deg.entries()]
    .filter(([id]) => byId.get(id) && byId.get(id).type !== 'raw')
    .map(([id, d]) => ({ id, title: byId.get(id).title ?? '', type: byId.get(id).type ?? '', degree: d.in + d.out, in: d.in, out: d.out }))
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, top)
}
