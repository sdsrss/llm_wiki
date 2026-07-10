import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kbPaths } from './paths.mjs'

const BUILTIN = {
  priority: ['openai', 'openrouter'],
  providers: {
    openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
    openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'anthropic/claude-sonnet-5' },
  },
}

function resolveProviders(fileCfg) {
  const { priority, providers } = fileCfg.providers ? fileCfg : BUILTIN
  for (const name of priority ?? Object.keys(providers)) {
    const prov = providers[name]
    if (!prov) continue
    const key = prov.apiKey ?? process.env[prov.apiKeyEnv]
    if (key) return { baseURL: prov.baseURL, apiKey: key, model: prov.model }
  }
  return null
}

export function loadLlmConfig(kbRoot) {
  const dir = process.env.LLM_WIKI_CONFIG_DIR ?? path.join(os.homedir(), '.llm-wiki')
  const globalFile = path.join(dir, 'config.json')
  const fileCfg = fs.existsSync(globalFile) ? JSON.parse(fs.readFileSync(globalFile, 'utf8')) : {}
  // flat form: explicit custom endpoint wins outright
  let cfg = (fileCfg.baseURL && fileCfg.apiKey && fileCfg.model)
    ? { baseURL: fileCfg.baseURL, apiKey: fileCfg.apiKey, model: fileCfg.model }
    : resolveProviders(fileCfg)
  const p = kbPaths(kbRoot)
  if (fs.existsSync(p.config)) {
    const kbCfg = JSON.parse(fs.readFileSync(p.config, 'utf8'))
    if (kbCfg.llm) {
      if (process.env.LLM_WIKI_ALLOW_KB_LLM_OVERRIDE === '1') {
        // Opt-in: trust the KB fully (e.g. your own first-party KB).
        cfg = { ...(cfg ?? {}), ...kbCfg.llm }
      } else {
        // Security: a third-party KB must not redirect requests (baseURL) or
        // inject credentials — that would leak the user's env API key to an
        // attacker endpoint. Honor only the model name by default.
        const ignored = Object.keys(kbCfg.llm).filter(key => key !== 'model')
        if (ignored.length) process.stderr.write(`warning: ignoring kb-level llm.${ignored.join(',')} override (security); set LLM_WIKI_ALLOW_KB_LLM_OVERRIDE=1 to allow\n`)
        if (kbCfg.llm.model !== undefined) cfg = { ...(cfg ?? {}), model: kbCfg.llm.model }
      }
    }
  }
  if (cfg && process.env.LLM_WIKI_API_KEY) cfg.apiKey = process.env.LLM_WIKI_API_KEY
  if (!cfg || !cfg.baseURL || !cfg.apiKey || !cfg.model) return null
  return cfg
}

// Node's built-in fetch rejects the npm undici package's dispatcher
// ("invalid onRequestStart method": handler interface mismatch between
// undici 8.x and Node's bundled undici), so when a proxy is configured we
// must use undici's own fetch together with its EnvHttpProxyAgent.
export async function makeTransport() {
  const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .some(v => process.env[v])
  if (!hasProxy) return { fetchImpl: globalThis.fetch, dispatcher: undefined }
  const { fetch: proxyFetch, EnvHttpProxyAgent } = await import('undici')
  return { fetchImpl: proxyFetch, dispatcher: new EnvHttpProxyAgent() }
}
