import { listWikiPages, isInvalidated } from './pages.mjs'
import { loadLlmConfig, makeTransport } from './llm-config.mjs'
import { sha256Text } from './hashing.mjs'
import { normalize, pageEmbedText, loadVectorStore, saveVectorStore } from './vector.mjs'
import { fetchWithRetry } from './retry.mjs'
import { embedLocal, isLocalModel, stripLocalPrefix } from './local-embed.mjs'

const BATCH = 64
// Safety margin under the 8192-token input limit of common embedding models
// (e.g. text-embedding-3-small). We cap ONLY the text sent to the embedding API;
// whole-page retrieval is unaffected — the page file and its BM25 text are never
// touched, only the vector's input is truncated so one huge page can't abort the run.
const EMBED_TOKEN_CAP = 8000

// Worst-case token count for the embedding API — deliberately NOT scanner's
// estimateTokens (chars/4), which underestimates dense markdown/code where real
// BPE runs ~2-3.5 chars/token and lets 8192-token pages slip through. This assumes
// the pessimistic ~2 chars/token for non-CJK and 1 token/char for CJK, halving
// usable capacity for English prose — the accepted tradeoff for a deterministic,
// provider-independent cap. A location vector doesn't need the page's tail.
// (CJK char class copied from scanner.mjs estimateTokens — kept local on purpose.)
function worstCaseEmbedTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[　-鿿豈-﫿]/.test(ch)) cjk++
  return cjk + (text.length - cjk) / 2
}

// Largest prefix of `text` whose worstCaseEmbedTokens is within EMBED_TOKEN_CAP.
// worstCaseEmbedTokens is monotonic non-decreasing in prefix length, so a binary
// search over the string finds the cut with no dependencies.
function capEmbedText(text) {
  if (worstCaseEmbedTokens(text) <= EMBED_TOKEN_CAP) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (worstCaseEmbedTokens(text.slice(0, mid)) <= EMBED_TOKEN_CAP) lo = mid
    else hi = mid - 1
  }
  // Slicing by UTF-16 code unit can split an astral char (e.g. emoji, CJK ext-B),
  // leaving a lone high surrogate (0xD800–0xDBFF) at the boundary. JSON.stringify
  // escapes it as a literal \uD83D and a strict provider can reject the request —
  // the exact abort this cap exists to prevent. Drop a dangling high surrogate.
  const last = text.charCodeAt(lo - 1)
  if (lo > 0 && last >= 0xD800 && last <= 0xDBFF) lo--
  return text.slice(0, lo)
}

export async function embedTexts(cfg, t, texts, { role = 'passage' } = {}) {
  if (isLocalModel(cfg.embeddingModel)) {
    return embedLocal(stripLocalPrefix(cfg.embeddingModel), texts, { role, pipelineFactory: t?.pipelineFactory })
  }
  const url = `${cfg.baseURL.replace(/\/$/, '')}/embeddings`
  let res
  try {
    res = await fetchWithRetry(t.fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.embeddingModel, input: texts }),
    }, { dispatcher: t.dispatcher, ...(t.retry ?? {}) })
  } catch (err) {
    // Mirror chatCompletion: turn undici's opaque "fetch failed" into a diagnosable
    // message naming the endpoint (mistyped baseURL / offline host / DNS failure).
    throw new Error(`could not reach the embedding endpoint ${url} — check baseURL/network in ~/.llm-wiki/config.json (${err.message})`)
  }
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

export async function embedKb(kbRoot, { fetchImpl, retry } = {}) {
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
    const raw = pageEmbedText(pg)
    const text = capEmbedText(raw)
    const truncated = text !== raw
    const hash = sha256Text(text)
    if (reuse[pg.relPath]?.hash === hash) { nextPages[pg.relPath] = reuse[pg.relPath]; reused++; continue }
    if (truncated) process.stderr.write(`warning: ${pg.relPath} embed text truncated to ~${EMBED_TOKEN_CAP} worst-case tokens (page exceeds embedding model input limit)\n`)
    jobs.push({ relPath: pg.relPath, text, hash })
  }
  let dim = (prev && prev.model === cfg.embeddingModel) ? prev.dim : null
  let embedded = 0
  if (jobs.length > 0) {
    const t = fetchImpl ? { fetchImpl, dispatcher: undefined, retry } : { ...(await makeTransport()), retry }
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
      // Incremental durability: persist after each batch so a later batch failing
      // (rate-limit, network) doesn't discard this batch's work — the re-run reuses
      // it by hash (zero repeat API cost). saveVectorStore is atomic (temp+rename).
      saveVectorStore(kbRoot, { model: cfg.embeddingModel, dim: dim ?? 0, pages: nextPages })
    }
  }
  const pruned = prev ? Object.keys(prev.pages).filter(id => !(id in nextPages)).length : 0
  const store = { model: cfg.embeddingModel, dim: dim ?? 0, pages: nextPages }
  saveVectorStore(kbRoot, store)
  return { embedded, reused, pruned, model: cfg.embeddingModel, dim: store.dim }
}
