import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAdjacency, shortestPath, neighborhood, hubs } from '../src/graph.mjs'

// a -> b -> c (wikilinks), d isolated, e -> b (typed relation), b -> raw/x.md (source)
const G = {
  nodes: [
    { id: 'a', type: 'source', title: 'A' },
    { id: 'b', type: 'entity', title: 'B' },
    { id: 'c', type: 'concept', title: 'C', status: 'invalidated' },
    { id: 'd', type: 'concept', title: 'D' },
    { id: 'e', type: 'source', title: 'E' },
    { id: 'raw/x.md', type: 'raw', title: 'x.md' },
  ],
  edges: [
    { source: 'a', target: 'b', type: 'wikilink', confidence: 'inferred' },
    { source: 'b', target: 'c', type: 'wikilink', confidence: 'inferred' },
    { source: 'e', target: 'b', type: 'implements', confidence: 'inferred' },
    { source: 'b', target: 'raw/x.md', type: 'source', confidence: 'extracted' },
  ],
}

test('buildAdjacency indexes both directions with edge metadata', () => {
  const adj = buildAdjacency(G)
  assert.deepEqual(adj.get('a'), [{ id: 'b', dir: 'out', type: 'wikilink', confidence: 'inferred' }])
  assert.ok(adj.get('b').some(n => n.id === 'a' && n.dir === 'in'))
  assert.deepEqual(adj.get('d'), [])
})

test('shortestPath traverses edges in either direction and reports hop metadata', () => {
  const r = shortestPath(G, 'a', 'e') // a ->(out) b <-(in) e
  assert.deepEqual(r.nodes, ['a', 'b', 'e'])
  assert.equal(r.hops.length, 2)
  assert.deepEqual(r.hops[0], { from: 'a', to: 'b', type: 'wikilink', confidence: 'inferred', dir: 'out' })
  assert.equal(r.hops[1].dir, 'in')
  assert.equal(r.hops[1].type, 'implements')
})

test('shortestPath: null when disconnected, trivial when from === to, throws on unknown id', () => {
  assert.equal(shortestPath(G, 'a', 'd'), null)
  assert.deepEqual(shortestPath(G, 'a', 'a'), { nodes: ['a'], hops: [] })
  assert.throws(() => shortestPath(G, 'a', 'zzz'), /unknown node: zzz/)
})

test('neighborhood expands by distance without revisiting and excludes self', () => {
  const r = neighborhood(G, 'a', 2)
  assert.deepEqual(r.map(n => [n.id, n.distance]), [['b', 1], ['c', 2], ['e', 2], ['raw/x.md', 2]])
  assert.ok(!r.some(n => n.id === 'a'))
  assert.equal(neighborhood(G, 'a', 1).length, 1)
  assert.throws(() => neighborhood(G, 'zzz'), /unknown node: zzz/)
})

test('hubs ranks by total degree, excludes raw nodes, respects top', () => {
  const r = hubs(G, { top: 2 })
  assert.deepEqual(r[0], { id: 'b', title: 'B', type: 'entity', degree: 4, in: 2, out: 2 })
  assert.equal(r.length, 2)
  assert.ok(!hubs(G).some(h => h.id === 'raw/x.md'), 'raw nodes are files, not pages — excluded')
})

test('graph queries surface node status and hubs guards dangling endpoints', () => {
  const g = {
    nodes: G.nodes,
    edges: [...G.edges, { source: 'ghost', target: 'b', type: 'wikilink' }], // dangling endpoint
  }
  const n = neighborhood(g, 'b', 1)
  assert.equal(n.find(x => x.id === 'c').status, 'invalidated')
  assert.equal(n.find(x => x.id === 'a').status, undefined)
  const p = shortestPath(g, 'a', 'c')
  assert.equal(p.hops[1].status, 'invalidated')
  const h = hubs(g)
  assert.equal(h.find(x => x.id === 'c').status, 'invalidated')
  assert.ok(!h.some(x => x.id === 'ghost'), 'dangling endpoint contributes no hub')
  assert.equal(h.find(x => x.id === 'b').in, 2, "dangling edge does not inflate b's in-degree")
})
