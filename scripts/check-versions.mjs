#!/usr/bin/env node
// Fails when package.json, .claude-plugin/plugin.json and .claude-plugin/marketplace.json
// disagree on the version — they are bumped by hand and drift silently otherwise.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(import.meta.url), '../..')
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))

const pkg = read('package.json')
const plugin = read('.claude-plugin/plugin.json')
const marketplace = read('.claude-plugin/marketplace.json')

const versions = {
  'package.json': pkg.version,
  '.claude-plugin/plugin.json': plugin.version,
  '.claude-plugin/marketplace.json (metadata)': marketplace.metadata?.version,
  '.claude-plugin/marketplace.json (plugins[0])': marketplace.plugins?.[0]?.version,
}

const distinct = new Set(Object.values(versions))
if (distinct.size !== 1) {
  console.error('version mismatch:')
  for (const [file, v] of Object.entries(versions)) console.error(`  ${file}: ${v}`)
  process.exit(1)
}
console.log(`versions in sync: ${pkg.version}`)
