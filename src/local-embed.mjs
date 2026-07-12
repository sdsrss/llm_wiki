// Local/offline embedding via transformers.js. The heavy dependency
// (@huggingface/transformers, ~253 MB) is an optionalDependency, imported ONLY here
// and ONLY when a `local:` embeddingModel is used — the base install stays lean. The
// pipeline factory is injectable so tests never touch the real dependency.

const LOCAL_PREFIX = 'local:'

export function isLocalModel(m) {
  return typeof m === 'string' && m.startsWith(LOCAL_PREFIX)
}

export function stripLocalPrefix(m) {
  return m.slice(LOCAL_PREFIX.length)
}

// A missing optional dependency surfaces as ERR_MODULE_NOT_FOUND — turn it into an
// actionable instruction instead of an opaque stack. Other errors pass through.
export function friendlyImportError(err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    return new Error('local embedding needs @huggingface/transformers; run: npm i @huggingface/transformers')
  }
  return err
}

// e5-family models are trained with asymmetric "query:" / "passage:" instruction
// prefixes; retrieval quality drops materially without them. Other families
// (e.g. paraphrase-multilingual) encode symmetrically and must NOT get a prefix.
function applyRolePrefix(model, texts, role) {
  if (!/e5/i.test(model)) return texts
  const tag = role === 'query' ? 'query: ' : 'passage: '
  return texts.map(t => tag + t)
}

// Default factory: dynamically import transformers.js and build a feature-extraction
// pipeline. Mean-pooled, UN-normalized — the shared normalize() in embed/ask applies
// the unit-length step, identical to the API path.
async function defaultPipelineFactory(model) {
  let transformers
  try {
    transformers = await import('@huggingface/transformers')
  } catch (err) {
    throw friendlyImportError(err)
  }
  const extractor = await transformers.pipeline('feature-extraction', model)
  return async (texts) => {
    const out = await extractor(texts, { pooling: 'mean', normalize: false })
    return out.tolist() // number[][], one row per input, in order
  }
}

// Cache the real (expensive) per-model load across a batch run / long-lived MCP
// server. An injected factory (tests) bypasses the cache so tests stay isolated.
const pipelineCache = new Map() // model -> Promise<embedFn>

export async function embedLocal(model, texts, { role = 'passage', pipelineFactory } = {}) {
  const prepared = applyRolePrefix(model, texts, role)
  if (pipelineFactory) {
    const embedFn = await pipelineFactory(model)
    return embedFn(prepared)
  }
  let entry = pipelineCache.get(model)
  if (!entry) {
    entry = defaultPipelineFactory(model)
    pipelineCache.set(model, entry)
  }
  let embedFn
  try { embedFn = await entry }
  catch (err) { pipelineCache.delete(model); throw err } // don't cache a failed load
  return embedFn(prepared)
}
