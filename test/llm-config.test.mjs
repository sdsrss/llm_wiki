import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadEmbedConfig } from '../src/llm-config.mjs'

// Hermeticity: LLM_WIKI_API_KEY is a bootstrap override (llm-config.mjs) that forces
// a non-null config and overrides apiKey — a developer exporting it (the single-var
// config the README advertises) otherwise flips config tests to real network calls.
// Clear it for the whole test process, alongside OPENAI_API_KEY/OPENROUTER_API_KEY.
delete process.env.LLM_WIKI_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.OPENROUTER_API_KEY

test('loadEmbedConfig: local model needs no chat creds; remote still needs them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  process.env.LLM_WIKI_CONFIG_DIR = dir
  t.after(() => delete process.env.LLM_WIKI_CONFIG_DIR)
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-kb-'))
  t.after(() => fs.rmSync(kb, { recursive: true, force: true }))

  // (a) flat config with ONLY a local embeddingModel, no baseURL/apiKey/model
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ embeddingModel: 'local:Xenova/multilingual-e5-small' }))
  const local = loadEmbedConfig(kb)
  assert.equal(local?.embeddingModel, 'local:Xenova/multilingual-e5-small', 'local model resolves with no chat creds')
  assert.equal(local.apiKey, undefined, 'no chat apiKey fabricated')

  // (b) a REMOTE embeddingModel without chat creds does NOT resolve
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ embeddingModel: 'text-embedding-3-small' }))
  assert.equal(loadEmbedConfig(kb), null, 'remote embedding needs chat creds (baseURL/apiKey)')

  // (c) full chat config carries the (remote) embeddingModel through
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    baseURL: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm', embeddingModel: 'text-embedding-3-small',
  }))
  assert.equal(loadEmbedConfig(kb)?.embeddingModel, 'text-embedding-3-small')

  // (d) provider-level local embeddingModel is scanned in PRIORITY order, not
  // insertion order — so it agrees with resolveProviders on which provider wins.
  // Here priority puts `beta` first though `alpha` is declared first; the old
  // Object.values scan would have returned alpha's model.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    priority: ['beta', 'alpha'],
    providers: {
      alpha: { baseURL: 'https://a.invalid/v1', apiKeyEnv: 'UNSET_A', embeddingModel: 'local:model-alpha' },
      beta: { baseURL: 'https://b.invalid/v1', apiKeyEnv: 'UNSET_B', embeddingModel: 'local:model-beta' },
    },
  }))
  assert.equal(loadEmbedConfig(kb)?.embeddingModel, 'local:model-beta', 'priority-first provider wins the embeddingModel scan')
})
