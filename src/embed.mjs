import { listWikiPages, isInvalidated } from './pages.mjs'
import { loadLlmConfig, makeTransport } from './llm-config.mjs'
import { sha256Text } from './hashing.mjs'
import { normalize, pageEmbedText, loadVectorStore, saveVectorStore } from './vector.mjs'

const BATCH = 64

export async function embedTexts(cfg, t, texts) {
  const res = await t.fetchImpl(`${cfg.baseURL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.embeddingModel, input: texts }),
    ...(t.dispatcher ? { dispatcher: t.dispatcher } : {}),
  })
  if (!res.ok) {
    let body = ''
    try { body = (await res.text()).slice(0, 200) } catch { /* status alone */ }
    throw new Error(`Embedding API error: ${res.status ?? 'network'}${body ? ` — ${body}` : ''}`)
  }
  const data = await res.json()
  if (!Array.isArray(data?.data) || data.data.length !== texts.length) {
    throw new Error(`Embedding API returned an unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return [...data.data].sort((a, b) => a.index - b.index).map(d => d.embedding)
}

export async function embedKb(kbRoot, { fetchImpl } = {}) {
  const cfg = loadLlmConfig(kbRoot)
  if (!cfg) throw new Error('No LLM configured. Create ~/.llm-wiki/config.json (OpenAI-compatible).')
  if (!cfg.embeddingModel) throw new Error('No embedding model configured. Add "embeddingModel" to your provider (or flat config) in ~/.llm-wiki/config.json, e.g. "text-embedding-3-small".')
  const pages = listWikiPages(kbRoot).filter(p => !p.error && !isInvalidated(p))
  const prev = loadVectorStore(kbRoot)
  const reuse = (prev && prev.model === cfg.embeddingModel) ? prev.pages : {}
  const jobs = []
  const nextPages = {}
  let reused = 0
  for (const pg of pages) {
    const text = pageEmbedText(pg)
    const hash = sha256Text(text)
    if (reuse[pg.relPath]?.hash === hash) { nextPages[pg.relPath] = reuse[pg.relPath]; reused++; continue }
    jobs.push({ relPath: pg.relPath, text, hash })
  }
  let dim = (prev && prev.model === cfg.embeddingModel) ? prev.dim : null
  let embedded = 0
  if (jobs.length > 0) {
    const t = fetchImpl ? { fetchImpl, dispatcher: undefined } : await makeTransport()
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH)
      const vecs = await embedTexts(cfg, t, batch.map(j => j.text))
      batch.forEach((j, bi) => {
        const n = normalize(vecs[bi])
        if (!n) return // pathological zero vector: page stays BM25-only
        if (dim === null) dim = n.length
        if (n.length !== dim) throw new Error(`Embedding dimension changed mid-run (${dim} -> ${n.length})`)
        nextPages[j.relPath] = { hash: j.hash, vec: n }
        embedded++
      })
    }
  }
  const pruned = prev ? Object.keys(prev.pages).filter(id => !(id in nextPages)).length : 0
  const store = { model: cfg.embeddingModel, dim: dim ?? 0, pages: nextPages }
  saveVectorStore(kbRoot, store)
  return { embedded, reused, pruned, model: cfg.embeddingModel, dim: store.dim }
}
