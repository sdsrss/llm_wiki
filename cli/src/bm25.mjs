const K1 = 1.2
const B = 0.75

export function tokenize(text) {
  const toks = []
  for (const w of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) toks.push(w)
  for (const run of text.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    for (let i = 0; i < run.length; i++) {
      toks.push(run[i])
      if (i < run.length - 1) toks.push(run.slice(i, i + 2))
    }
  }
  return toks
}

export function buildBm25Index(docs) {
  const df = new Map()
  const docTerms = docs.map(d => {
    const tf = new Map()
    const toks = tokenize(d.text)
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    return { id: d.id, tf, len: toks.length }
  })
  const avgLen = docTerms.reduce((s, d) => s + d.len, 0) / (docTerms.length || 1)
  return { docTerms, df, avgLen, n: docs.length }
}

export function searchBm25(index, query, k = 6) {
  const qTerms = [...new Set(tokenize(query))]
  const scores = index.docTerms.map(d => {
    let score = 0
    for (const t of qTerms) {
      const f = d.tf.get(t)
      if (!f) continue
      const idf = Math.log(1 + (index.n - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5))
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / index.avgLen))
    }
    return { id: d.id, score }
  })
  return scores.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k)
}
