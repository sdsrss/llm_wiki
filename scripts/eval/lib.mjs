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
  return Object.fromEntries(Object.entries(byArm).map(([arm, rs]) => [arm, {
    n: rs.length,
    recall: mean(rs.map(r => r.recall)),
    mrr: mean(rs.map(r => r.mrr)),
    avgMs: mean(rs.map(r => r.ms)),
  }]))
}
