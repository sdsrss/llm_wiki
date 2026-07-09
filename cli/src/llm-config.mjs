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
    if (kbCfg.llm) cfg = { ...(cfg ?? {}), ...kbCfg.llm }
  }
  if (cfg && process.env.LLM_WIKI_API_KEY) cfg.apiKey = process.env.LLM_WIKI_API_KEY
  if (!cfg || !cfg.baseURL || !cfg.apiKey || !cfg.model) return null
  return cfg
}

export function makeDispatcher() {
  const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .some(v => process.env[v])
  if (!hasProxy) return undefined
  // lazy import so tests without undici installed paths still run fast
  return import('undici').then(({ EnvHttpProxyAgent }) => new EnvHttpProxyAgent())
}
