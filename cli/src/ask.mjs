import fs from 'node:fs'
import path from 'node:path'
import { kbPaths } from './paths.mjs'
import { listWikiPages } from './pages.mjs'
import { buildBm25Index, searchBm25 } from './bm25.mjs'
import { loadLlmConfig, makeTransport } from './llm-config.mjs'

export function retrievePages(kbRoot, question, k = 6) {
  const pages = listWikiPages(kbRoot).filter(p => !p.error)
  const idx = buildBm25Index(pages.map(p => ({
    id: p.relPath,
    text: [p.data.title, p.data.description, (p.data.tags ?? []).join(' '), p.body].join('\n'),
  })))
  return searchBm25(idx, question, k).map(h => ({ relPath: h.id, score: h.score }))
}

export async function askKb(kbRoot, question, { k = 6, retrieveOnly = false, fetchImpl } = {}) {
  const p = kbPaths(kbRoot)
  const hits = retrievePages(kbRoot, question, k)
  if (retrieveOnly) return { pages: hits, answer: null }
  const cfg = loadLlmConfig(kbRoot)
  if (!cfg) throw new Error('No LLM configured. Create ~/.llm-wiki/config.json with {"baseURL","apiKey","model"} (OpenAI-compatible).')
  const index = fs.existsSync(p.indexMd) ? fs.readFileSync(p.indexMd, 'utf8') : ''
  const fullPages = hits.map(h => `<page path="${h.relPath}">\n${fs.readFileSync(path.join(p.wiki, h.relPath), 'utf8')}\n</page>`)
  const messages = [
    { role: 'system', content: 'You answer strictly from the provided llm_wiki pages. Cite pages inline as [[dir/slug]]. If the pages do not contain the answer, say so. Answer in the language of the question.' },
    { role: 'user', content: `Knowledge base index:\n${index}\n\nRelevant full pages:\n${fullPages.join('\n')}\n\nQuestion: ${question}` },
  ]
  // Injected fetchImpl (tests) is used as-is with no dispatcher; otherwise
  // pick the proxy-aware transport (undici fetch + agent, or global fetch).
  const t = fetchImpl ? { fetchImpl, dispatcher: undefined } : await makeTransport()
  const res = await t.fetchImpl(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages }),
    ...(t.dispatcher ? { dispatcher: t.dispatcher } : {}),
  })
  if (!res.ok) throw new Error(`LLM API error: ${res.status ?? 'network'}`)
  const data = await res.json()
  return { pages: hits, answer: data.choices[0].message.content }
}
