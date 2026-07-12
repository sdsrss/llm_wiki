#!/usr/bin/env node
// OPT-IN manual smoke — NOT part of `node --test`, NOT run in CI.
// Downloads the real multilingual-e5-small model (first run ~120 MB) and checks a
// cross-language retrieval works end-to-end with NO API key.
// Usage: node scripts/smoke-local-embed.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initKb } from '../src/init.mjs'
import { embedKb } from '../src/embed.mjs'
import { locatePages } from '../src/ask.mjs'

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-smoke-'))
initKb(kb)
fs.writeFileSync(path.join(kb, 'wiki/sources/cats.md'),
  `---\ntype: source\ntitle: Domestic cats\ndescription: about house cats\ntags: [cats]\nsources: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nThe domestic cat is a small carnivorous mammal kept as a pet.`)
fs.writeFileSync(path.join(kb, 'wiki.config.json'), JSON.stringify({ vectorEnabled: true }))
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-smoke-cfg-'))
process.env.LLM_WIKI_CONFIG_DIR = cfgDir
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ embeddingModel: 'local:Xenova/multilingual-e5-small' }))

console.log('embedding (first run downloads the model)...')
const e = await embedKb(kb)
console.log('embedded:', e)
const r = await locatePages(kb, '家猫是什么动物', { retrieval: 'hybrid' }) // Chinese query, English page
console.log('hits:', r.hits.map(h => h.relPath))
if (!r.hits.some(h => h.relPath === 'sources/cats.md')) { console.error('FAIL: cross-language hit missing'); process.exit(1) }
console.log('OK: cross-language local retrieval works')
fs.rmSync(kb, { recursive: true, force: true })
fs.rmSync(cfgDir, { recursive: true, force: true })
