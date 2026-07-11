// scripts/eval/lib.mjs — pure metric functions (unit-tested; no IO)
export function recallAtK(expected, got, k) {
  if (expected.length === 0) return 0
  const top = new Set(got.slice(0, k))
  return expected.filter(id => top.has(id)).length / expected.length
}

export function mrr(expected, got) {
  const want = new Set(expected)
  const i = got.findIndex(id => want.has(id))
  return i === -1 ? 0 : 1 / (i + 1)
}

export function summarize(rows) {
  const byArm = {}
  for (const r of rows) (byArm[r.arm] ??= []).push(r)
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  const agg = (rs) => ({
    n: rs.length,
    recall: mean(rs.map(r => r.recall)),
    mrr: mean(rs.map(r => r.mrr)),
    avgMs: mean(rs.map(r => r.ms)),
  })
  return Object.fromEntries(Object.entries(byArm).map(([arm, rs]) => {
    const byType = {}
    for (const r of rs) (byType[r.type ?? 'fact'] ??= []).push(r)
    return [arm, {
      ...agg(rs),
      byType: Object.fromEntries(Object.entries(byType).map(([ty, trs]) => [ty, agg(trs)])),
    }]
  }))
}

// Same wikilink shape src/export.mjs converts: [[target(#anchor)?(|alias)?]].
export function extractCitations(text) {
  const out = []
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const id = m[1].trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

// v2 was judged with A/B swapped: flip it back, keep only verdicts both
// orderings agree on (position-bias control), tie otherwise.
export function deswap(v1, v2swapped) {
  const flip = (x) => x === 'A' ? 'B' : x === 'B' ? 'A' : 'tie'
  return Object.fromEntries(Object.keys(v1).map(d => {
    const v2 = flip(v2swapped[d])
    return [d, v1[d] === v2 ? v1[d] : 'tie']
  }))
}

export function headToHead(pairs) {
  const dims = ['correctness', 'citations', 'completeness']
  return Object.fromEntries(dims.map(d => {
    const c = { A: 0, B: 0, tie: 0, n: pairs.length }
    for (const p of pairs) c[p[d]] += 1
    return [d, c]
  }))
}

export function abstentionSummary(rows) {
  const byArm = {}
  for (const r of rows) (byArm[r.arm] ??= []).push(r)
  return Object.fromEntries(Object.entries(byArm).map(([arm, rs]) => {
    const none = rs.filter(r => r.type === 'none')
    const answerable = rs.filter(r => r.type !== 'none')
    const rate = (xs) => xs.length === 0 ? null : xs.filter(r => r.abstained).length / xs.length
    return [arm, { nNone: none.length, nAnswerable: answerable.length, abstentionRate: rate(none), falseAbstentionRate: rate(answerable) }]
  }))
}
